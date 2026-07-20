/**
 * BulkyGen Pipeline Module
 * Autonomous processing orchestrator.
 *
 * Lifecycle for each Supabase record:
 *   1. fetchPendingRecord()     — get next record with status='pending'
 *   2. markProcessing()         — claim it (prevent double-processing)
 *   3. submitPrompt()           — inject into Flow via existing background loop
 *   4. captureImage()           — wait for image data URL from generation result
 *   5. processImage()           — strip metadata, compress JPEG, apply watermark
 *   6. embedMetadata()          — write EXIF/IPTC fields (Wave 3)
 *   7. uploadToGoogleDrive()    — upload (Wave 4)
 *   8. updateSupabaseRecord()   — set status=completed with all result fields
 *   9. next()                   — fetch next record immediately
 *
 * In Wave 1 (this file), steps 5–8 are stubs — the loop runs fully but just
 * passes the image straight through and skips Drive/metadata updates.
 * The autonomous loop itself IS live and does real Supabase polling + Flow generation.
 */
(function () {
    'use strict';

    const TAG = 'Pipeline';

    // ── Module accessors (loaded as importScripts in background.js) ─────────────
    const log = () => globalThis.bulkygenLogger;
    const stats = () => globalThis.bulkygenStatistics;
    const cfg = () => globalThis.bulkygenSettings;
    const supa = () => globalThis.bulkygenSupabase;
    const canvas = () => globalThis.bulkygenCanvasProcessor;
    const meta = () => globalThis.bulkygenMetadataWriter;
    const auth = () => globalThis.bulkygenGoogleAuth;
    const drive = () => globalThis.bulkygenGoogleDrive;

    // ── Internal state ───────────────────────────────────────────────────────────
    let _running = false;   // is the autonomous loop active?
    let _stopFlag = false;   // set to true to halt after current record
    let _pollTimer = null;    // setTimeout handle for next poll
    let _forceRun = false;   // true when explicitly started via startPipeline message (bypasses autonomousMode check)

    // Registry: pendingResultId → { resolve, reject, timer }
    // Lets the pipeline await the pushed image result from the existing generation loop.
    const _pendingResults = new Map();

    /**
     * Called by background.js when a generation finishes via the existing loop.
     * Resolves the matching pending result promise.
     */
    function deliverGenerationResult(itemId, result) {
        const waiter = _pendingResults.get(itemId);
        if (waiter) {
            clearTimeout(waiter.timer);
            _pendingResults.delete(itemId);
            waiter.resolve(result);
        }
    }

    /**
     * Wait for the existing generation loop to push a result for the given itemId.
     * Times out after timeoutMs, but also probes generation status every HEARTBEAT_MS.
     * Fails fast if the loop exited, the worker is unreachable, OR the loop is
     * stuck in a readiness phase with no progress (the silent-hang case).
     */
    const HEARTBEAT_MS = 10000; // ping every 10 seconds
    const READINESS_STALL_MS = 45000; // ensure_cs / check_page must progress within 45s
    const GENERATING_STALL_MS = 240000; // generating/flow_submit may take longer
    const READINESS_PHASES = new Set([
        'starting', 'finding_tab', 'ensure_cs', 'ensure_cs_done', 'check_page', 'recovered', 'aborted'
    ]);

    function _abortHungGeneration(reason) {
        try {
            if (globalThis.bulkygenGeneration?.abort) {
                globalThis.bulkygenGeneration.abort(reason);
                return;
            }
        } catch (e) { /* fall through */ }
        try {
            globalThis.ext?.runtime?.sendMessage({ action: 'abortGeneration', reason })?.catch(() => { });
        } catch (e) { /* ignore */ }
    }

    function _getGenerationStatusSyncOrNull() {
        try {
            if (globalThis.bulkygenGeneration?.getStatus) {
                return globalThis.bulkygenGeneration.getStatus();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function _awaitGenerationResult(itemId, timeoutMs = 300000) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn, arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(hardTimer);
                clearInterval(heartbeat);
                _pendingResults.delete(itemId);
                fn(arg);
            };

            // Hard deadline — last-resort safety net. Also abort the SW loop so
            // loopActive cannot stay true and poison the next record.
            const hardTimer = setTimeout(() => {
                _abortHungGeneration(`pipeline hard timeout for itemId=${itemId}`);
                settle(reject, new Error(`Generation timeout after ${timeoutMs / 1000}s for itemId=${itemId}`));
            }, timeoutMs);

            const heartbeat = setInterval(async () => {
                if (settled) { clearInterval(heartbeat); return; }
                try {
                    let res = _getGenerationStatusSyncOrNull();
                    if (!res) {
                        const ext = globalThis.ext;
                        if (!ext) return;
                        res = await ext.runtime.sendMessage({ action: 'checkGenerationAlive' });
                    }
                    // Undefined/null response (self-message quirk) ⇒ treat as unknown, keep waiting
                    // unless we can prove the loop is dead.
                    if (!res) return;

                    if (res.alive === false) {
                        settle(reject, new Error('Generation loop exited unexpectedly — no result will arrive for itemId=' + itemId));
                        return;
                    }

                    const stalledMs = typeof res.stalledMs === 'number' ? res.stalledMs : null;
                    const phase = res.phase || 'unknown';
                    if (stalledMs != null) {
                        if (READINESS_PHASES.has(phase) && stalledMs > READINESS_STALL_MS) {
                            const reason = `Generation loop stalled in readiness phase="${phase}" for ${Math.round(stalledMs / 1000)}s`;
                            log()?.warn(TAG, reason + ` — aborting (itemId=${itemId})`);
                            _abortHungGeneration(reason);
                            settle(reject, new Error(reason + ` for itemId=${itemId}`));
                            return;
                        }
                        if ((phase === 'generating' || phase === 'flow_submit' || phase === 'flow_submit_retry') && stalledMs > GENERATING_STALL_MS) {
                            const reason = `Generation loop stalled in phase="${phase}" for ${Math.round(stalledMs / 1000)}s`;
                            log()?.warn(TAG, reason + ` — aborting (itemId=${itemId})`);
                            _abortHungGeneration(reason);
                            settle(reject, new Error(reason + ` for itemId=${itemId}`));
                        }
                    }
                } catch (e) {
                    // Message channel gone (worker restart) — also means loop is dead
                    settle(reject, new Error('Background worker unreachable — generation loop likely restarted (itemId=' + itemId + ')'));
                }
            }, HEARTBEAT_MS);

            _pendingResults.set(itemId, { resolve: (r) => settle(resolve, r), reject: (e) => settle(reject, e), timer: hardTimer });
        });
    }

    // ── Backoff utility ──────────────────────────────────────────────────────────
    async function _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function _backoffMs(attempt, baseMs = 2000, maxMs = 60000) {
        return Math.min(baseMs * Math.pow(2, attempt), maxMs);
    }

    // ── Main pipeline for a single record ───────────────────────────────────────

    /**
     * Process one Supabase record end-to-end.
     *
     * @param {Object} record — normalized record from bulkygenSupabase.normalizeRecord()
     * @param {Object} settings — current settings snapshot
     * @returns {Promise<void>}
     */
    async function processRecord(record, settings) {
        const { id, prompt } = record;
        if (!prompt) {
            log()?.warn(TAG, `Record ${id} has no prompt — skipping`);
            await supa()?.markFailed(settings, id, 'No prompt in record');
            return;
        }

        log()?.info(TAG, `Processing record ${id}`, { prompt: prompt.slice(0, 60) });
        const startMs = Date.now();

        if (_stopFlag) {
            throw new Error('Pipeline stopped by user');
        }

        // ── Stage 1: Mark processing in Supabase ──────────────────────────────
        await supa()?.markProcessing(settings, id);
        await stats()?.setStatus('generating', prompt);

        // ── Stage 2: Feed prompt into the existing generation loop ────────────
        // We create a synthetic queue item and inject it directly into chrome.storage.local
        // so the existing background loop's startGeneration() picks it up.
        // The autonomousPipelineItemId is used to match the pushed result.
        const itemId = `pipeline-${id}-${Date.now()}`;
        const syntheticQueue = [{
            id: itemId,
            prompt,
            status: 'pending',
            _pipelineRecordId: id
        }];

        const ext = globalThis.ext;
        if (!ext) throw new Error('ext API not available in pipeline context');

        // Tell the existing queue system to run this one item
        await ext.storage.local.set({
            queue: syntheticQueue,
            currentIndex: 0,
            isRunning: true,
            isPaused: false
        });

        // Register the waiter BEFORE starting generation so early failures
        // (no tab / checkPage fail) cannot be delivered into a void and leave
        // us hanging for 300s.
        log()?.info(TAG, `Waiting for generation result for item ${itemId}...`);
        const resultPromise = _awaitGenerationResult(itemId, 300000);

        // Prefer in-process start (same service worker) — avoids unreliable
        // chrome.runtime.sendMessage self-calls that can resolve to null/undefined
        // without ever invoking startGeneration.
        let startAck = null;
        try {
            if (globalThis.bulkygenGeneration?.tryStart) {
                startAck = globalThis.bulkygenGeneration.tryStart();
            } else {
                startAck = await ext.runtime.sendMessage({ action: 'startGeneration' });
            }
        } catch (e) {
            startAck = null;
            log()?.warn(TAG, `startGeneration signal failed: ${e?.message || e}`);
        }

        if (!startAck || startAck.started !== true) {
            const reason = startAck?.reason || (startAck == null ? 'no_ack' : 'unknown');
            _abortHungGeneration(`startGeneration not acknowledged (${reason})`);
            // Reject the waiter if still pending so we don't double-wait
            try {
                deliverGenerationResult(itemId, {
                    success: false,
                    error: `startGeneration was not started (reason=${reason})`
                });
            } catch (e) { /* ignore */ }
            throw new Error(`startGeneration was rejected by background (${reason}) — a previous generation loop is likely still active`);
        }

        // ── Stage 3: Wait for image result ─────────────────────────────────────
        const result = await resultPromise;

        if (!result || !result.success || (!result.imageData && !(result.multipleImages?.length))) {
            const err = result?.error || 'No image data returned';
            throw new Error(`Generation failed: ${err}`);
        }

        // Collect all images returned (Flow x2/x4 may return multiple)
        const allImages = Array.isArray(result.multipleImages) && result.multipleImages.length
            ? result.multipleImages
            : [{ imageData: result.imageData, meta: result.meta }];

        log()?.info(TAG, `Got ${allImages.length} image(s) for record ${id}`);

        // Process the first image (primary result)
        const primary = allImages[0];
        const imageDataUrl = primary.imageData;
        if (!imageDataUrl) throw new Error('imageData is empty');

        const processingStartMs = Date.now();

        // ── Stage 4: Strip metadata + compress (stub in Wave 1) ───────────────
        await stats()?.setStatus('uploading', prompt);

        // Build watermark options: per-record fields take priority; global settings are the fallback.
        const wm = {
            enabled: record.watermarkEnabled === true ? true : settings.watermarkEnabled,
            text: record.watermarkText !== undefined ? record.watermarkText : settings.watermarkText,
            logoUrl: record.watermarkLogoUrl !== undefined ? record.watermarkLogoUrl : settings.watermarkLogoUrl,
            opacity: record.watermarkOpacity !== undefined ? record.watermarkOpacity : settings.watermarkOpacity,
            position: record.watermarkPosition !== undefined ? record.watermarkPosition : settings.watermarkPosition,
            rotation: record.watermarkRotation !== undefined ? record.watermarkRotation : settings.watermarkRotation,
            font: record.watermarkFont !== undefined ? record.watermarkFont : settings.watermarkFont,
            scale: record.watermarkScale !== undefined ? record.watermarkScale : settings.watermarkScale,
            margin: record.watermarkMargin !== undefined ? record.watermarkMargin : settings.watermarkMargin
        };

        const processed = await canvas()?.processImage(imageDataUrl, wm, { jpegQuality: settings.jpegQuality })
            || { dataUrl: imageDataUrl, width: 0, height: 0 };

        // ── Stage 4.5: Generate Processing Hash ───────────────────────────────
        const processingHashStr = `${record.prompt}|${settings.jpegQuality}|${wm.enabled}|${JSON.stringify(record._raw?.metadata || {})}`;
        const processingHash = await computeSha256(processingHashStr);

        // ── Stage 5: Embed metadata ────────────────────────────────────────────
        // metadataEnabled in global settings gates this stage. Per-record fields override globals.
        const metaEnabled = record.metadataEnabled === true ? true : (settings.metadataEnabled !== false);
        let finalDataUrl = processed.dataUrl;
        let metadataWritten = false;
        if (metaEnabled && meta()?.isSupported() && finalDataUrl && finalDataUrl.startsWith('data:image/jpeg')) {
            try {
                const jpegBlob = dataUrlToBlob(finalDataUrl);
                const metadataToEmbed = {
                    schema_version: 1,
                    seo: {
                        title: record.title || settings.metadataTitle,
                        description: record.description || settings.metadataDescription,
                        keywords: (() => {
                            const raw = record.keywords || settings.metadataKeywords || '';
                            return typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw;
                        })()
                    },
                    rights: {
                        creator: record.author || settings.metadataAuthor,
                        copyright_notice: record.copyright || settings.metadataCopyright,
                        website: record.website || settings.metadataWebsite
                    },
                    generation: {
                        software: 'BulkyGen Extension',
                        generator: 'Flow Autonomous',
                        image_id: record.id,
                        prompt_id: record.id
                    },
                    processing: {
                        processing_hash: processingHash
                    },
                    dates: {
                        created_at: new Date().toISOString()
                    }
                };
                const embeddedBlob = await meta().embedMetadata(jpegBlob, metadataToEmbed);
                finalDataUrl = await blobToDataUrl(embeddedBlob);
                metadataWritten = true;
            } catch (err) {
                log()?.error(TAG, `Metadata embedding failure: ${err.message}`);
            }
        }

        // ── Stage 6: Upload to Google Drive (Wave 4) ──────────────────────────
        const uploadStartMs = Date.now();
        let driveResult = { fileId: null, driveUrl: null, thumbnailUrl: null, size: 0 };
        if (settings.driveEnabled) {
            log()?.info(TAG, 'Google Drive upload enabled — proceeding...');
            const token = await auth()?.getAccessToken(false);
            if (!token) {
                throw new Error('Google Drive enabled but no valid OAuth token found. Please open settings/dashboard to authenticate.');
            }

            let folderId = settings.driveFolderId || 'root';
            if (settings.driveAutoFolder && record.folder) {
                folderId = await drive().getOrCreateFolder(record.folder, folderId, token);
            }

            let filename;
            if (record.filename && record.filename.trim() !== '') {
                filename = record.filename.trim().replace(/\s+/g, '-');
                if (!/\.(jpe?g|png|gif|webp)$/i.test(filename)) {
                    filename += '.jpeg';
                }
            } else {
                const basename = record.prompt;
                filename = formatFilename(settings.driveNamingTemplate, basename, record.id);
            }
            const finalBlob = dataUrlToBlob(finalDataUrl);

            driveResult = await drive().uploadFile(finalBlob, filename, folderId, token);
        }
        const uploadTimeMs = Date.now() - uploadStartMs;

        // ── Stage 6.5: Compute Final Image SHA-256 ────────────────────────────
        const finalBlobHashBlob = dataUrlToBlob(finalDataUrl);
        const finalSha256 = await computeSha256(finalBlobHashBlob);

        // ── Stage 7: Update Supabase record ────────────────--------------------
        const processingTimeMs = Date.now() - processingStartMs;
        const totalTimeMs = Date.now() - startMs;

        const existingMeta = record._raw?.metadata || {};
        const newMeta = {
            ...existingMeta,
            output_stats: {
                drive_file_id: driveResult.fileId,
                thumbnail: driveResult.thumbnailUrl,
                width: processed.width || primary.meta?.width || 0,
                height: processed.height || primary.meta?.height || 0,
                filesize: driveResult.size || 0,
                processing_time: Math.round(processingTimeMs / 1000),
                upload_time: Math.round(uploadTimeMs / 1000),
                metadata_written: metadataWritten,
                watermark: !!wm.enabled,
                compression: settings.jpegQuality,
                image_format: 'jpeg',
                sha256: finalSha256,
                processing_hash: processingHash
            }
        };

        const deviceStr = settings.deviceName || (globalThis.navigator && globalThis.navigator.userAgent) || 'Unknown Device';

        const updateFields = {
            status: 'completed',
            image_url: driveResult.driveUrl,
            updated_at: new Date().toISOString(),
            error_message: null,
            worker_id: deviceStr,
            generated_by: deviceStr,
            metadata: newMeta
        };

        await supa()?.updateRecord(settings, id, updateFields);

        // ── Stage 8: Record statistics ──────────────────────────────────────────
        await stats()?.recordProcessed(totalTimeMs);
        if (uploadTimeMs > 100) await stats()?.recordUploaded(uploadTimeMs);
        await stats()?.setLastImage({
            driveUrl: driveResult.driveUrl,
            thumbnail: driveResult.thumbnailUrl,
            prompt
        });
        await stats()?.setStatus('completed', prompt);

        log()?.info(TAG, `Record ${id} completed in ${totalTimeMs}ms`);

        // Notify the dashboard popup
        const extRuntime = (globalThis.chrome || globalThis.browser)?.runtime;
        extRuntime?.sendMessage({ action: 'pipelineRecordComplete', recordId: id, prompt }).catch(() => { });
    }

    // ── Retry wrapper ────────────────────────────────────────────────────────────

    async function _processWithRetry(record, settings) {
        const maxRetries = settings.maxRetries || 5;
        let lastError = null;
        let currentAttempts = record.attempts || 0;
        const deviceStr = settings.deviceName || (globalThis.navigator && globalThis.navigator.userAgent) || 'Unknown Device';

        let wasStopped = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (_stopFlag) {
                // Without this check, stop() only cancelled the CURRENT wait —
                // the for-loop kept going and immediately called processRecord()
                // again with zero delay, which submitted a brand new prompt to
                // Flow on every single remaining retry attempt. That's why stop
                // never actually stopped anything until all retries burned through.
                wasStopped = true;
                lastError = lastError || new Error('Pipeline stopped by user');
                break;
            }
            try {
                // We pass currentAttempts down so processRecord can update it on success if needed, 
                // but actually processRecord leaves attempts alone on success.
                record.attempts = currentAttempts; 
                await processRecord(record, settings);
                return; // success
            } catch (err) {
                lastError = err;
                currentAttempts++;
                log()?.warn(TAG, `Record ${record.id} attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message}`);

                if (_stopFlag) {
                    wasStopped = true;
                    break;
                }

                if (attempt < maxRetries) {
                    // Update Supabase to show it's retrying
                    try {
                        const currentSettings = await cfg()?.get() || settings;
                        await supa()?.updateRecord(currentSettings, record.id, {
                            status: 'retry',
                            attempts: currentAttempts,
                            error_message: lastError.message,
                            updated_at: new Date().toISOString(),
                            worker_id: deviceStr,
							generated_by: deviceStr
                        });
                    } catch (e) {
                        log()?.warn(TAG, `Could not update retry status in Supabase: ${e.message}`);
                    }

                    const delay = _backoffMs(attempt, settings.retryBaseMs || 2000, settings.retryMaxMs || 60000);
                    log()?.info(TAG, `Retrying record ${record.id} in ${delay}ms...`);
                    await _sleep(delay);
                }
            }
        }

        if (wasStopped) {
            // A user-requested stop is not a real failure — put the record back
            // to 'pending' so it's picked up immediately on the next start()
            // instead of sitting at 'failed' or waiting for the 10-minute
            // stuck-record reclaim sweep.
            log()?.info(TAG, `Record ${record.id} processing halted by stop request; returning to pending`);
            try {
                const currentSettings = await cfg()?.get() || settings;
                await supa()?.updateRecord(currentSettings, record.id, {
                    status: 'pending',
                    attempts: currentAttempts,
                    error_message: null,
                    updated_at: new Date().toISOString(),
                    worker_id: deviceStr,
					generated_by: deviceStr
                });
            } catch (e) {
                log()?.warn(TAG, `Could not reset record ${record.id} to pending after stop: ${e.message}`);
            }
            return;
        }

        // All retries exhausted
        log()?.error(TAG, `Record ${record.id} failed after ${maxRetries + 1} attempts: ${lastError?.message}`);
        await stats()?.recordFailed();
        await stats()?.setLastError(lastError?.message || 'Unknown error');
        try {
            const currentSettings = await cfg()?.get() || settings;
            await supa()?.updateRecord(currentSettings, record.id, {
                status: 'failed',
                attempts: currentAttempts,
                error_message: lastError?.message || 'Unknown error',
                updated_at: new Date().toISOString(),
                worker_id: deviceStr,
				generated_by: deviceStr
            });
        } catch (e) {
            log()?.warn(TAG, `Could not mark record ${record.id} as failed in Supabase: ${e.message}`);
        }
    }

    // ── Autonomous poll loop ─────────────────────────────────────────────────────

    async function _poll() {
        if (_stopFlag) {
            _running = false;
            await stats()?.setStatus('idle');
            log()?.info(TAG, 'Autonomous loop stopped');
            return;
        }

        let settings;
        try {
            settings = await cfg()?.get();
        } catch (e) {
            log()?.error(TAG, 'Failed to load settings, retrying in 10s', e.message);
            _pollTimer = setTimeout(_poll, 10000);
            return;
        }

        if (!settings.autonomousMode && !_forceRun) {
            log()?.verbose(TAG, 'autonomousMode=false and not force-started, poll loop exiting');
            _running = false;
            await stats()?.setStatus('idle');
            return;
        }

        // Check Supabase is configured
        const configured = await cfg()?.isSupabaseConfigured();
        if (!configured) {
            log()?.warn(TAG, 'Supabase not configured — waiting 30s before retry');
            await stats()?.setStatus('idle');
            _pollTimer = setTimeout(_poll, 30000);
            return;
        }

        try {
            await stats()?.setStatus('waiting');

            const rawRecord = await supa()?.fetchPendingRecord(settings);
            if (!rawRecord) {
                // No pending records — wait for the configured poll interval
                log()?.verbose(TAG, `No pending records — polling again in ${settings.pollIntervalMs}ms`);
                await stats()?.setStatus('idle');
                await stats()?.setQueueSize(0);
                _pollTimer = setTimeout(_poll, settings.pollIntervalMs || 5000);
                return;
            }

            const record = supa()?.normalizeRecord(rawRecord, settings);
            log()?.info(TAG, `Found pending record id=${record.id}: "${(record.prompt || '').slice(0, 60)}"`);

            // Fetch actual queue count for dashboard display
            try {
                const queueCount = await supa()?.fetchPendingCount(settings) || 1;
                await stats()?.setQueueSize(queueCount);
            } catch (e) {
                await stats()?.setQueueSize(1); // fallback
            }

            await _processWithRetry(record, settings);

        } catch (err) {
            log()?.error(TAG, `Poll cycle error: ${err.message}`);
            await stats()?.setStatus('error');
            await stats()?.setLastError(err.message);
        }

        // Schedule next poll immediately if loop is still active
        if (!_stopFlag) {
            const pollMs = settings?.pollIntervalMs || 5000;
            _pollTimer = setTimeout(_poll, 100); // quick poll after success; idle waits pollMs above
        } else {
            // stop() was called while a record was in-flight — since we're not
            // rescheduling, this is the last chance to clear _running. Without
            // this, _running stays stuck true forever and every future start()
            // call just logs "already running" and does nothing.
            _running = false;
            await stats()?.setStatus('idle');
            log()?.info(TAG, 'Autonomous loop stopped');
        }
    }

    // ── Public API ───────────────────────────────────────────────────────────────

    const pipeline = {
        /**
         * Start the autonomous Supabase → Flow → Process → Upload loop.
         * Safe to call multiple times; will not start a second loop.
         */
        async start(force = false) {
            if (_running) {
                log()?.warn(TAG, 'Pipeline already running');
                return;
            }
            _stopFlag = false;
            _running = true;
            _forceRun = force;
            log()?.info(TAG, `Autonomous pipeline starting (force=${force})`);

            // Keep pipelineRunning in sync for the keepalive/watchdog alarm.
            // Auto-start used to skip this, so the alarm could race-start
            // generation against a stale genTabId while the pipeline also started.
            try {
                await globalThis.ext?.storage?.local?.set({ pipelineRunning: true });
            } catch (e) { /* non-fatal */ }

            // Reclaim any records left stuck at status='processing' by a worker
            try {
                const settings = await cfg()?.get();
                if (settings) {
                    const reclaimed = await supa()?.reclaimStuckRecords(settings, 10);
                    if (reclaimed) log()?.info(TAG, `Reclaimed ${reclaimed} stuck 'processing' record(s)`);
                }
            } catch (e) {
                log()?.warn(TAG, `Reclaim sweep failed (non-fatal): ${e.message}`);
            }

            _poll();
        },

        /**
         * Gracefully stop the loop after the current record finishes.
         * Also immediately cancels any in-flight wait for a generation result,
         * since previously "stop" only affected the poll loop between records
         * and did nothing while a record was actively waiting (up to 300s).
         */
        stop() {
            _stopFlag = true;
            _forceRun = false;
            if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
            for (const [itemId, waiter] of _pendingResults) {
                clearTimeout(waiter.timer);
                waiter.reject(new Error('Pipeline stopped by user'));
            }
            _pendingResults.clear();

            // Cancelling a pending result above only cancels the PIPELINE's own
            // wait — it does nothing to the actual Flow generation loop running
            // in background.js, which has no idea the pipeline gave up. That
            // loop keeps `loopActive`/`isRunning` set to true in background.js,
            // so the next record's startGeneration call gets silently rejected
            // (reason: 'loopActive') or never acknowledged, and the record just
            // sits waiting for the full 300s timeout with zero log activity.
            // Explicitly stopping the background loop here keeps its state in
            // sync with the pipeline so the next record can actually start.
            try {
                if (globalThis.bulkygenGeneration?.abort) {
                    globalThis.bulkygenGeneration.abort('pipeline stop');
                } else {
                    globalThis.ext?.runtime?.sendMessage({ action: 'stopGeneration' })?.catch(() => { });
                }
            } catch (e) { /* no listener / context gone — non-fatal */ }
            try {
                globalThis.ext?.storage?.local?.set({ pipelineRunning: false })?.catch?.(() => { });
            } catch (e) { /* ignore */ }

            log()?.info(TAG, 'Autonomous pipeline stop requested');
        },

        /** True while the loop is running. */
        get isRunning() { return _running; },

        /**
         * Deliver a generation result from the existing loop machinery.
         * Called by background.js message handler when action='generationResult'
         * and the item originated from the pipeline.
         */
        deliverGenerationResult,

        /**
         * Called by background.js when the generation loop exits for any reason
         * (finally block). Immediately rejects ALL pending result waiters so they
         * fail fast instead of sitting out their full 300-second timeout with zero
         * activity. The pipeline's retry wrapper will then pick up and retry.
         */
        onGenerationLoopDied() {
            if (_pendingResults.size === 0) return;
            log()?.warn(TAG, `Generation loop died — force-failing ${_pendingResults.size} pending waiter(s)`);
            for (const [itemId, waiter] of _pendingResults) {
                try {
                    clearTimeout(waiter.timer);
                    waiter.reject(new Error('Generation loop exited unexpectedly — pipeline will retry'));
                } catch (e) { /* ignore */ }
            }
            _pendingResults.clear();
        }
    };

    globalThis.bulkygenPipeline = pipeline;

    // ── Local Image Format Helpers ───────────────────────────────────────────
    function dataUrlToBlob(dataUrl) {
        const parts = dataUrl.split(',');
        const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
        const bytes = atob(parts[1]);
        const buf = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
        return new Blob([buf], { type: mime });
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function formatFilename(template, baseName, id) {
        const rawTemplate = template || '{index}-{date}';
        const cleanBase = sanitizeFilename(baseName || 'media');
        const dateStr = new Date().toISOString().slice(0, 10);
        const stamp = formatTimestampForName(Date.now());

        let out = rawTemplate
            .replace('{prompt}', cleanBase.substring(0, 60))
            .replace('{filename}', cleanBase)
            .replace('{id}', String(id))
            .replace('{date}', dateStr)
            .replace('{timestamp}', stamp)
            .replace('{index}', String(id));

        if (!out.toLowerCase().endsWith('.jpg') && !out.toLowerCase().endsWith('.jpeg')) {
            out += '.jpg';
        }
        return out;
    }

    function sanitizeFilename(name) {
        if (typeof name !== 'string') return 'media';
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 60);
    }

    function formatTimestampForName(ts) {
        const d = new Date(ts);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }

    async function computeSha256(data) {
        let buffer;
        if (typeof data === 'string') {
            buffer = new TextEncoder().encode(data);
        } else if (data instanceof Blob) {
            buffer = await data.arrayBuffer();
        } else {
            throw new Error('Unsupported data type for hash');
        }
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
})();