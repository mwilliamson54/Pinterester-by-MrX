// Part of background.js, split out for readability. Runs in the same
// service-worker global scope as background.js and the other
// background/*.js files (loaded via importScripts — NOT ES modules),
// so everything here shares state (isRunning, isPaused, etc.) with them
// exactly as it did when this was all one file.

// ── Flow credit-safety envelope ──────────────────────────────────────────────
// Every Flow prompt is driven by the JOB LEDGER (modules/job-ledger.js), not by
// a blind retry counter. For each prompt the loop repeatedly asks the ledger
// "what is allowed next?" and gets exactly one of:
//
//   submit   click Generate (costs credits)   - only if it was never submitted,
//                                               or the previous submission was
//                                               PROVEN to have failed, and the
//                                               per-job submit budget is not spent
//   recover  re-scan the existing result tiles and read the image (free)
//   reuse    the image is already captured and stored - do not touch Flow
//   blocked  ambiguous; stop and ask a human (state = needs_attention)
//
// "No image captured" is therefore never a reason to click Generate again.
// The old behaviour (retry = resubmit, up to 9 times per prompt, and unlimited
// for the other providers) is what burned credits.
//
// FLOW_PER_ATTEMPT_TIMEOUT_MS bounds one content-script call (submit incl. the
// 120s result wait). modules/pipeline.js derives its hard timeout from
// BULKYGEN_FLOW_RETRY_BUDGET_MS so it can never fire while this loop is still
// legitimately working through submit -> recover.
const FLOW_PER_ATTEMPT_TIMEOUT_MS = 180000;
const FLOW_RETRY_BACKOFF_MS = 1500;
const FLOW_UI_FAILURE_LIMIT = 3;     // "could not click" failures (free) before we stop
const FLOW_TRANSPORT_ERROR_LIMIT = 3; // content script unreachable
globalThis.BULKYGEN_FLOW_RETRY_BUDGET_MS =
  2 * (FLOW_PER_ATTEMPT_TIMEOUT_MS + 60000) +   // up to 2 submits
  3 * (45000 + 30000) +                         // up to 3 capture-only scans
  60000;                                        // backoff / slack

async function startGeneration(resumeTabId) {
  if (loopActive) return; // a loop is already running in this worker
  // Claim a fresh run token for THIS invocation and remember it in a local
  // const, not a shared variable. isRunning/loopActive can be flipped back
  // to true by a restart before an OLD, still-in-flight run has actually
  // finished — this token is what lets that old run recognize it's been
  // superseded and stop touching the tab, even though isRunning now reads
  // true again. See the __genRunSeq comment in state-and-status.js.
  const myRun = beginGenerationRun();
  const stillMine = () => isRunning && isCurrentGenerationRun(myRun);
  loopActive = true;
  loopActiveSince = Date.now();
  isRunning = true;
  markLoopProgress('starting');
  if (resumeTabId == null) { isPaused = false; __runCapturedHashes.clear(); }
  try {
    await ext.storage.local.set({ isRunning: true, isPaused });
    startSwKeepAlive();
    armKeepAliveAlarm();

    let tabId = resumeTabId;
    markLoopProgress('finding_tab');

    if (tabId == null) {
      // 1. Try the currently active tab first
      const [activeTab] = await ext.tabs.query({ active: true, currentWindow: true });
      if (activeTab && isSupportedTabUrl(activeTab.url)) {
        tabId = activeTab.id;
      } else {
        // 2. Search ALL open tabs for any supported generator page
        const allTabs = await ext.tabs.query({});
        const supportedTab = allTabs.find(t => isSupportedTabUrl(t.url));
        const linkedToolTab = globalThis.bulkygenToolLink?.firstToolTab?.();
        if (supportedTab) {
          tabId = supportedTab.id;
          console.log(`BulkyGen: Using background tab ${tabId} (${supportedTab.url.slice(0, 60)}...)`);
        } else if (linkedToolTab != null) {
          tabId = linkedToolTab;   // Gemini-hosted tool page that linked itself over the bridge
        } else {
          // 3. No supported page open anywhere — report error and exit
          const msg = 'No supported generator page found. Please open one of:\n- Flow: https://flow.google.com/project\n- Meta AI: https://www.meta.ai/media\n- Grok: https://grok.com/imagine\n- Digen: https://digen.ai/image\n- Gentube: https://www.gentube.app/create\n- Firefly: https://firefly.adobe.com/generate/image';
          logToExtension('warn', 'Background', 'startGeneration aborted — no supported tab found. ' + msg.split('\n')[0]);
          try { globalThis.bulkygenToolLink?.publishRun('idle', { error: 'No Flow tab is open. Open your Flow project page (https://labs.google/fx/tools/flow or https://flow.google.com/project) in another tab, then press Start again.' }); } catch (e) { /* ignore */ }
          notifyPopup('generationError', { message: msg });
          await _reportPipelineStartFailure('No supported generator page found');
          await _failQueuedItems('No supported generator page found');
          isRunning = false;
          loopActive = false; loopActiveSince = null;
          await ext.storage.local.set({ isRunning: false });
          return;
        }
      }
    }

    currentTabId = tabId;
    await ext.storage.local.set({ genTabId: tabId });
    logToExtension('info', 'Background', `startGeneration: using tab ${tabId}`);
    // Hold the page's silent-audio keep-alive for the entire run so it stays
    // unthrottled in the background between every prompt / fetch / retry.
    try { ext.tabs.sendMessage(tabId, { action: 'bgKeepAlive', on: true }).catch(() => { }); } catch (e) { }
    let currentProvider = 'unknown';

    // A Gemini-hosted Bulk Generator page has no provider content script: it is
    // driven over the tool bridge (api engine) instead of by DOM automation.
    let geminiTab = !!globalThis.bulkygenToolLink?.isToolTab?.(currentTabId);
    if (!geminiTab) {
      try { const t = await ext.tabs.get(currentTabId); geminiTab = !!(t && t.url && t.url.includes('gemini.google.com/')); } catch (e) { /* ignore */ }
    }
    if (geminiTab && !(await globalThis.bulkygenToolLink?.ensureLinked?.(currentTabId, 6000))) {
      const msg = 'Gemini page found, but the Bulk Generator tool did not answer over the bridge. Make sure the tool is open (not just the Gemini chat), wait for "Bridge: linked to extension" in its status bar, then press Start. If it never links, the tool runs in an iframe the extension cannot reach - see the extension service-worker log for the frame URLs.';
      logToExtension('warn', 'Background', msg);
      notifyPopup('generationError', { message: msg });
      await _reportPipelineStartFailure('tool bridge not linked');
      await _failQueuedItems('tool bridge not linked');
      isRunning = false; loopActive = false; loopActiveSince = null;
      await ext.storage.local.set({ isRunning: false });
      return;
    }

    // Make sure the content script is loaded (no manual page reload needed).
    // Bounded: executeScript can hang indefinitely on awkward tab states.
    markLoopProgress('ensure_cs');
    logToExtension('info', 'Background', `Ensuring content script on tab ${currentTabId}...`);
    const csOk = geminiTab ? true : await ensureTabContentScript(currentTabId);
    if (!csOk) {
      logToExtension('warn', 'Background', `ensureTabContentScript did not confirm injection on tab ${currentTabId}; continuing to checkPage anyway.`);
    } else {
      markLoopProgress('ensure_cs_done');
    }

    // Verify we're on a supported page (works without `tabs` permission)
    // Retry a few times: right after ensureTabContentScript() resolves, the
    // content script may not have finished registering its message listener
    // yet (a common MV3 race — "Receiving end does not exist"). Each attempt
    // is also time-bounded so a hung tabs.sendMessage cannot burn 300s.
    markLoopProgress('check_page');
    let checkRes = geminiTab ? { isSupportedPage: true, provider: 'gemini-tool' } : null;
    let checkErr = null;
    for (let i = 0; i < 4 && !checkRes; i++) {
      if (!stillMine()) break;
      try {
        logToExtension('info', 'Background', `checkPage attempt ${i + 1}/4 on tab ${currentTabId}...`);
        const res = await withTimeout(
          ext.tabs.sendMessage(currentTabId, { action: 'checkPage' }),
          5000,
          `checkPage attempt ${i + 1}`
        );
        if (res && res.isSupportedPage) {
          checkRes = res;
          break;
        }
        checkErr = new Error('Unsupported page');
      } catch (e) {
        checkErr = e;
        logToExtension('warn', 'Background', `checkPage attempt ${i + 1}/4 failed: ${e?.message || e}`);
      }
      await sleep(500);
    }

    if (!checkRes) {
      const reason = `checkPage failed: ${checkErr?.message || 'unsupported page'}`;
      logToExtension('warn', 'Background', `startGeneration aborted — checkPage never succeeded on tab ${currentTabId} (${checkErr?.message || 'unknown reason'}).`);
      notifyPopup('generationError', {
        message: 'Please navigate to a supported page:\n- Flow: https://flow.google.com/project\n- Digen: https://digen.ai/image\n- Gentube: https://www.gentube.app/create\n- Firefly: https://firefly.adobe.com/generate/image\n- Meta AI: https://www.meta.ai/media\n- Grok: https://x.com/i/grok'
      });
      await _reportPipelineStartFailure(reason);
      await _failQueuedItems(reason);
      isRunning = false;
      loopActive = false; loopActiveSince = null;
      await ext.storage.local.set({ isRunning: false });
      return;
    }
    currentProvider = checkRes.provider || 'unknown';
    markLoopProgress('generating');
    logToExtension('info', 'Background', `Using provider="${currentProvider}" on tab ${currentTabId} for this run.`);

    const data = await ext.storage.local.get(['queue', 'delay']);
    const queue = data.queue || [];
    const delay = (data.delay || 1) * 1000; // Faster default delay (1s)
    try {
      const st = await globalThis.bulkygenSettings?.get?.();
      globalThis.bulkygenJobs?.configure(st);
    } catch (e) { /* defaults are fine */ }
    try { globalThis.bulkygenToolLink?.publishRun('running', { provider: currentProvider, tabId: currentTabId }); } catch (e) { /* ignore */ }

    if (currentProvider === 'flow') {
      await runFlowSequentialGeneration(queue, delay, stillMine);
    } else if (currentProvider === 'gemini-tool') {
      await runToolApiGeneration(queue, stillMine);
    } else {
      // Generic provider loop (Digen, Gentube, Meta AI, Grok, ...). Runs in the
      // background no matter which tab is focused (keep-alive + background-safe
      // waits live in the content script). Retries are capped (see below).
      // Bounded: these providers have no receipt/recover logic, so every retry
      // is a fresh paid submission. Cap it and back off instead of looping.
      const MAX_RETRIES = 2;
      const RETRY_BACKOFF_MS = 2000;
      const GENERIC_GAP_MS = 0;       // no spacing between successful prompts
      const isGrok = currentProvider === 'grok';

      for (let i = 0; i < queue.length && stillMine(); i++) {
        if (queue[i].status === 'completed') continue;

        // Honor Pause without losing our place in the queue.
        await waitWhilePaused();
        if (!stillMine()) break;

        // Mark current item as processing.
        queue[i].status = 'processing';
        await ext.storage.local.set({ queue, currentIndex: i });
        notifyPopup('updateQueue', { queue });

        let attempt = 0;
        let succeeded = false;
        let fatalDisconnect = false;

        while (attempt <= MAX_RETRIES && stillMine() && !succeeded) {
          try {
            if (!stillMine()) break; // superseded between the while-check and here

            await ensureTabContentScript(currentTabId);
            if (!stillMine()) break; // don't submit on behalf of a dead run

            // Ask the content script to generate for this prompt.
            // Register a fallback waiter FIRST: long generations can outlive the
            // sendMessage response channel in MV3. If the channel closes, we wait
            // for the content script's pushed result instead of regenerating.
            const __waiter = registerResultWaiter(queue[i].id, 300000);
            let response;
            try {
              response = await ext.tabs.sendMessage(currentTabId, {
                action: 'generateImage',
                prompt: queue[i].prompt,
                itemId: queue[i].id
              });
              __waiter.cancel();
            } catch (sendErr) {
              const smsg = (sendErr && sendErr.message) || String(sendErr);
              if (/message channel closed|asynchronous response|message port closed/i.test(smsg)) {
                console.log(`⏳ ${currentProvider}: response channel closed for prompt ${i + 1}; awaiting pushed result (no regeneration)...`);
                response = await __waiter.promise;
                if (!response) {
                  throw new Error('Generation result not received after the response channel closed');
                }
              } else {
                __waiter.cancel();
                throw sendErr;
              }
            }

            if (!response || !response.success) {
              throw new Error(response?.error || 'Generation failed');
            }

            // This response may have taken a long time to arrive (up to the
            // full per-attempt timeout). If a newer run has started in the
            // meantime, this run is stale — discard the result instead of
            // writing it into a queue/pipeline record that no longer belongs
            // to us, and stop touching the tab immediately.
            if (!stillMine()) {
              logToExtension('warn', 'Background', `Discarding a late result for item ${queue[i].id} — this generation run was superseded by a newer run.`);
              return;
            }

            // Save whatever media came back.
            let captured = false;
            if (response.multipleVideos && Array.isArray(response.multipleVideos) && response.multipleVideos.length) {
              // Meta AI: multiple videos per prompt.
              console.log(`\u{1F4F9} Saving ${response.multipleVideos.length} Meta AI videos...`);
              for (let videoIdx = 0; videoIdx < response.multipleVideos.length; videoIdx++) {
                const videoData = response.multipleVideos[videoIdx];
                try {
                  await saveGeneratedImage(
                    videoData.imageData,
                    `${queue[i].prompt} (Video ${videoIdx + 1}/${response.multipleVideos.length})`,
                    queue[i].id,
                    videoData.meta
                  );
                  captured = true;
                } catch (saveError) {
                  console.error(`Video ${videoIdx + 1} save error (continuing):`, saveError);
                }
              }
            } else if (response.imageData) {
              // Single image/video for the other providers. If it's a duplicate of
              // an image already captured for an earlier slot, fail so the loop
              // auto-retries and regenerates a fresh one for THIS slot.
              if (isDuplicateCapture(response.imageData)) {
                throw new Error('Only a duplicate of an earlier image was captured; regenerating for a fresh result');
              }
              await saveGeneratedImage(response.imageData, queue[i].prompt, queue[i].id, response.meta);
              captured = true;
            }

            // Nothing captured -> treat as failure so it auto-retries in place.
            if (!captured) {
              const why = response.meta && response.meta.captureError
                ? `capture failed: ${response.meta.captureError}`
                : 'no media captured';
              throw new Error(why);
            }

            // Success.
            queue[i].status = 'completed';
            await ext.storage.local.set({ queue });
            notifyPopup('updateQueue', { queue });
            succeeded = true;

            // Deliver result to pipeline if this item originated from autonomous mode
            if (queue[i]._pipelineRecordId && globalThis.bulkygenPipeline) {
              try {
                globalThis.bulkygenPipeline.deliverGenerationResult(queue[i].id, {
                  success: true,
                  imageData: response.imageData,
                  multipleImages: response.multipleVideos || null,
                  meta: response.meta
                });
              } catch (e) { /* ignore */ }
            }

            // For Grok: go back to the homepage so the next prompt is ready.
            if (response.needsNavigation && response.navigateTo) {
              console.log('\u{1F504} Grok: navigating to', response.navigateTo, 'for next generation...');
              try {
                await ext.tabs.update(currentTabId, { url: response.navigateTo });
                await waitForPageReady(currentTabId, 30);
              } catch (navErr) {
                console.error('Grok navigation error:', navErr);
              }
            }
          } catch (error) {
            console.error('Generation error:', error);

            // A dead content-script connection can't be retried on this tab as-is;
            // try one forced re-inject, otherwise stop the run.
            if (error.message && error.message.includes('Could not establish connection')) {
              try {
                await ensureTabContentScript(currentTabId, true);
                await sleep(500);
              } catch (reinjectErr) {
                fatalDisconnect = true;
                break;
              }
            }

            attempt++;
            console.log(`\u{1F501} ${currentProvider}: prompt ${i + 1} failed (${error.message}); retrying immediately (attempt ${attempt})...`);
            notifyPopup('generationError', {
              message: `Prompt ${i + 1} failed (${error.message.replace('CONTENT_MODERATED: ', '')}); auto-retrying...`
            });

            // Keep the slot marked processing while we retry in place.
            queue[i].status = 'processing';
            await ext.storage.local.set({ queue });
            notifyPopup('updateQueue', { queue });

            // For Grok: failures (moderation/timeout) need a return to the
            // homepage before the next attempt can work.
            if (isGrok) {
              try {
                await ext.tabs.update(currentTabId, { url: 'https://grok.com/imagine/' });
                await waitForPageReady(currentTabId, 30);
              } catch (navError) {
                console.error('Navigation error:', navError);
              }
            }

            if (RETRY_BACKOFF_MS > 0) await sleep(RETRY_BACKOFF_MS);
          }
        }

        await ext.storage.local.set({ queue });
        notifyPopup('updateQueue', { queue });

        if (fatalDisconnect) {
          notifyPopup('generationError', {
            message: 'Content script not loaded. Please refresh the current generator page and try again.'
          });
          isRunning = false;
          break;
        }

        // Move to the next prompt the instant this one's media is captured.
        const hasMorePending = queue.slice(i + 1).some(item => item.status !== 'completed');
        if (hasMorePending && stillMine() && GENERIC_GAP_MS > 0) {
          await sleep(GENERIC_GAP_MS);
        }
      }
    }
    // Generation complete
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
    notifyPopup('generationComplete', {});

    // Show system notification
    if (ext.notifications) {
      ext.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'BulkyGen Complete',
        message: 'Bulk generation process finished.'
      });
    }
  } finally {
    loopActive = false; loopActiveSince = null;
    markLoopProgress('idle');
    try { globalThis.bulkygenToolLink?.publishRun('idle', {}); } catch (e) { /* ignore */ }
    // Notify any pipeline waiters that the loop is gone so they fail fast
    // instead of burning their full 300-second timeout with zero activity.
    // This is the single most important escape hatch: if startGeneration exits
    // for ANY reason (tab gone, checkPage failed, fatalDisconnect, normal finish)
    // the pipeline learns about it within milliseconds instead of 300 seconds.
    try { globalThis.bulkygenPipeline?.onGenerationLoopDied?.(); } catch (e) { /* ignore */ }
    if (!isRunning) {
      stopSwKeepAlive();
      disarmKeepAliveAlarm();
      if (currentTabId != null) {
        try { ext.tabs.sendMessage(currentTabId, { action: 'bgKeepAlive', on: false }).catch(() => { }); } catch (e) { }
      }
    }
  }
}

// One content-script round trip, keyed by a unique callId so a late/duplicate
// push from an EARLIER call can never be mistaken for this call's result.
async function callFlowContent(message, timeoutMs) {
  const callId = `call-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  message = Object.assign({}, message, { callId });
  const waiter = registerResultWaiter(callId, timeoutMs);
  try {
    return await Promise.race([
      ext.tabs.sendMessage(currentTabId, message),
      waiter.promise.then((r) => {
        if (r == null) throw new Error(`${message.action} timed out waiting for the content script`);
        return r;
      })
    ]);
  } catch (sendErr) {
    const smsg = (sendErr && sendErr.message) || String(sendErr);
    if (/message channel closed|asynchronous response|message port closed/i.test(smsg)) {
      // Long generations outlive the sendMessage channel in MV3. The content
      // script also PUSHES its result, so wait for that - never resend.
      logToExtension('info', 'Flow', `Response channel closed during ${message.action}; awaiting pushed result (no resend)...`);
      const r = await waiter.promise;
      if (!r) throw new Error('Result not received after the response channel closed');
      return r;
    }
    throw sendErr;
  } finally {
    waiter.cancel();
  }
}

async function loadStoredImages(itemId) {
  try {
    const rows = await globalThis.bulkygenImageStore.getImagesByItemId(itemId);
    const out = [];
    for (const r of rows.slice().reverse()) {
      if (!r.blob) continue;
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onloadend = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(r.blob);
      });
      out.push({ imageData: dataUrl, meta: r.meta });
    }
    return out;
  } catch (e) {
    return [];
  }
}

/**
 * Run ONE Flow prompt to completion under the job ledger.
 * Returns { ok, images, error, needsAttention, aborted, reused }.
 * The number of times Generate is clicked is decided by the ledger, not here.
 */
async function runFlowJob(item, jobKey, stillMine) {
  const J = globalThis.bulkygenJobs;
  const cfg = J.getConfig();
  let uiFailures = 0;
  let transportErrors = 0;

  for (let turn = 0; turn < 24 && stillMine(); turn++) {
    await waitWhilePaused();
    if (!stillMine()) return { ok: false, aborted: true };

    const job = await J.ensure(jobKey, {
      prompt: item.prompt, aspectRatio: item.aspectRatio || null, itemId: item.id,
      source: item._toolJobId ? 'tool' : (item._pipelineRecordId ? 'pipeline' : 'queue')
    });
    const d = J.decide(job);

    if (d.action === 'reuse') {
      const imgs = await loadStoredImages(job.itemId || item.id);
      if (imgs.length) {
        logToExtension('info', 'Flow', `Job ${jobKey}: already captured - reusing ${imgs.length} stored image(s), Flow untouched.`);
        return { ok: true, images: imgs, reused: true };
      }
      logToExtension('warn', 'Flow', `Job ${jobKey}: ledger says captured but stored images are gone; releasing so it can be regenerated.`);
      await J.release(jobKey);
      continue;
    }

    if (d.action === 'blocked') {
      await J.markNeedsAttention(jobKey, d.reason);
      return { ok: false, needsAttention: true, error: d.reason };
    }

    let res;
    try {
      await ensureTabContentScript(currentTabId);
      if (!stillMine()) return { ok: false, aborted: true };

      if (d.action === 'recover') {
        await J.noteRecoverTry(jobKey);
        markLoopProgress('flow_recover');
        logToExtension('info', 'Flow', `Job ${jobKey}: ${d.reason} -> capture-only scan (no Generate click).`);
        res = await callFlowContent({
          action: 'flowRecoverCapture', itemId: (job.lastSubmit && job.lastSubmit.itemId) || job.itemId || item.id,
          jobKey, waitMs: cfg.recoverWaitMs
        }, cfg.recoverWaitMs + 30000);
      } else {
        markLoopProgress('flow_submit');
        logToExtension('info', 'Flow', `Job ${jobKey}: ${d.reason} -> submit (${job.submitCount}/${cfg.maxSubmitsPerJob} used).`);
        res = await callFlowContent({
          action: 'flowSubmitPrompt', prompt: item.prompt, itemId: item.id, jobKey,
          aspectRatio: item.aspectRatio || null
        }, FLOW_PER_ATTEMPT_TIMEOUT_MS + 60000);
      }
      markLoopProgress('flow_result');
      transportErrors = 0;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      transportErrors++;
      logToExtension('warn', 'Flow', `Job ${jobKey}: content call failed (${msg}) [${transportErrors}/${FLOW_TRANSPORT_ERROR_LIMIT}]. The ledger decides what happens next; nothing is blindly resent.`);
      if (transportErrors >= FLOW_TRANSPORT_ERROR_LIMIT) {
        const reason = `Flow tab unreachable (${msg}). Refresh the Flow project page.`;
        await J.markNeedsAttention(jobKey, reason);
        return { ok: false, needsAttention: true, fatalDisconnect: true, error: reason };
      }
      try { await ensureTabContentScript(currentTabId, true); } catch (e) { /* next turn will tell */ }
      await sleep(FLOW_RETRY_BACKOFF_MS * transportErrors);
      continue;
    }

    if (!stillMine()) {
      logToExtension('warn', 'Flow', `Discarding a late result for job ${jobKey} - this generation run was superseded.`);
      return { ok: false, aborted: true };
    }

    // If the page found this job's result tiles, Flow DID accept the prompt,
    // even when no receipt was seen at click time. Record that so the ledger
    // never treats a visible result as "maybe it never submitted".
    if (res && res.submitted && job.lastSubmit && !job.lastSubmit.confirmed) {
      await J.noteConfirmed(jobKey, res.receiptBy || 'result_seen');
    }

    // ── interpret what the page reported ────────────────────────────────────
    const imgs = Array.isArray(res && res.multipleImages) && res.multipleImages.length
      ? res.multipleImages
      : (res && res.imageData ? [{ imageData: res.imageData, meta: res.meta }] : []);

    if (res && res.success && imgs.length) {
      // Drop images already stored for an earlier slot (Flow can re-serve a
      // previous preview). A duplicate means "not THIS prompt's image" - that
      // is a capture problem, not a reason to pay for another generation.
      const fresh = imgs.filter(fi => !isDuplicateCapture(fi.imageData));
      if (fresh.length === 0) {
        logToExtension('warn', 'Flow', `Job ${jobKey}: only duplicates of earlier images were captured; re-scanning instead of regenerating.`);
        await J.noteRecoverTry(jobKey);
        continue;
      }
      let saved = 0;
      for (let n = 0; n < fresh.length; n++) {
        const label = fresh.length > 1 ? `${item.prompt} (${n + 1}/${fresh.length})` : item.prompt;
        for (let tryNo = 0; tryNo < 3; tryNo++) {
          try {
            await saveGeneratedImage(fresh[n].imageData, label, item.id, fresh[n].meta);
            saved++;
            break;
          } catch (saveError) {
            console.error('Flow image save error:', saveError);
            await sleep(500);
          }
        }
      }
      if (saved > 0) {
        await J.markCaptured(jobKey, { imageCount: saved, itemId: item.id });
      } else {
        logToExtension('error', 'Flow', `Job ${jobKey}: image captured but could not be saved to local storage; continuing with the in-memory copy.`);
      }
      return { ok: true, images: fresh };
    }

    if (res && res.phase === 'blocked') {
      // The ledger itself refused the click. Loop once more so decide() routes
      // to recover/blocked; the turn cap prevents any spin.
      logToExtension('warn', 'Flow', `Job ${jobKey}: submit refused by ledger (${res.error}).`);
      continue;
    }

    if (res && res.provenFailed) {
      logToExtension('warn', 'Flow', `Job ${jobKey}: Flow showed a failed tile (${res.error}).`);
      await J.noteProvenFailure(jobKey, res.error);
      await sleep(FLOW_RETRY_BACKOFF_MS);
      continue;
    }

    if (res && res.phase === 'no_context') {
      const reason = `Cannot recover: ${res.error}`;
      await J.markNeedsAttention(jobKey, reason);
      return { ok: false, needsAttention: true, error: reason };
    }

    if (res && res.phase === 'submit_failed') {
      // Nothing was clicked (the content script refunded the ledger), so no
      // credits were spent. Bounded because a broken page would spin forever.
      uiFailures++;
      logToExtension('warn', 'Flow', `Job ${jobKey}: could not submit (${res.error}) [${uiFailures}/${FLOW_UI_FAILURE_LIMIT}] - no credits spent.`);
      if (uiFailures >= FLOW_UI_FAILURE_LIMIT) {
        await J.markNeedsAttention(jobKey, `Could not drive the Flow page: ${res.error}`);
        return { ok: false, needsAttention: true, error: `Could not drive the Flow page: ${res.error}` };
      }
      await sleep(FLOW_RETRY_BACKOFF_MS * uiFailures);
      continue;
    }

    // submitted_no_capture, or an unlabelled failure (e.g. the page unloaded
    // mid-generation): the ledger knows whether the click happened and decides
    // between recover / submit / blocked on the next turn.
    logToExtension('info', 'Flow', `Job ${jobKey}: ${(res && res.error) || 'no result'} - deferring to ledger.`);
    await sleep(500);
  }

  if (!stillMine()) return { ok: false, aborted: true };
  await J.markNeedsAttention(jobKey, 'Job loop guard reached without a result');
  return { ok: false, needsAttention: true, error: 'Job loop guard reached without a result' };
}

/**
 * Gemini-hosted Bulk Generator (api engine). The extension owns the queue and the
 * credit guard; the tool page only performs the API call and returns the image.
 * Each prompt may be requested at most maxSubmitsPerJob times, and only after a
 * definitive API failure. A timeout (answer unknown) is never re-requested.
 */
async function runToolApiGeneration(queue, stillMine) {
  const J = globalThis.bulkygenJobs;
  const link = globalThis.bulkygenToolLink;
  if (!J || !link) throw new Error('Job ledger / tool link modules are not loaded');
  const cfg = J.getConfig();

  for (let i = 0; i < queue.length && stillMine(); i++) {
    const item = queue[i];
    if (item.status === 'completed') continue;
    await waitWhilePaused();
    if (!stillMine()) break;

    item.status = 'processing';
    await ext.storage.local.set({ queue, currentIndex: i });
    notifyPopup('updateQueue', { queue });

    const jobKey = flowJobKeyFor(item);
    let out = null;

    for (let turn = 0; turn < cfg.maxSubmitsPerJob + 2 && stillMine() && !out; turn++) {
      const job = await J.ensure(jobKey, { prompt: item.prompt, aspectRatio: item.aspectRatio || null, itemId: item.id, source: 'tool' });
      const d = J.decide(job);
      if (d.action === 'reuse') {
        const imgs = await loadStoredImages(job.itemId || item.id);
        if (imgs.length) { out = { ok: true, images: imgs, reused: true }; break; }
        await J.release(jobKey); continue;
      }
      const auth = await J.authorizeSubmit(jobKey, item.id, { prompt: item.prompt, aspectRatio: item.aspectRatio || null });
      if (!auth.allowed) {
        await J.markNeedsAttention(jobKey, auth.reason);
        out = { ok: false, needsAttention: true, error: auth.reason };
        break;
      }
      await J.noteConfirmed(jobKey, 'api_request_sent');
      markLoopProgress('tool_api');
      const r = await link.runApi(currentTabId, { id: item.id, prompt: item.prompt, aspectRatio: item.aspectRatio || null }, 180000);
      if (!stillMine()) { out = { aborted: true }; break; }

      if (r && r.ok && r.dataUrl) {
        const images = [{ imageData: r.dataUrl, meta: { provider: 'gemini-tool', itemId: item.id, type: 'image' } }];
        let saved = 0;
        for (let t = 0; t < 3 && !saved; t++) {
          try { await saveGeneratedImage(r.dataUrl, item.prompt, item.id, images[0].meta); saved = 1; }
          catch (e) { await sleep(500); }
        }
        if (saved) await J.markCaptured(jobKey, { imageCount: 1, itemId: item.id });
        out = { ok: true, images };
      } else if (r && (r.timeout || r.unreachable)) {
        // Unknown whether the API call ran. Never re-request blindly.
        const reason = `${r.error}. Not re-requesting (it may have completed); check the tool page.`;
        await J.markNeedsAttention(jobKey, reason);
        out = { ok: false, needsAttention: true, error: reason };
      } else {
        await J.noteProvenFailure(jobKey, (r && r.error) || 'API call failed');
        await sleep(FLOW_RETRY_BACKOFF_MS);
      }
    }

    if (out && out.aborted) { await ext.storage.local.set({ queue }); return; }
    if (!out) {
      const st = await J.get(jobKey);
      const why = (st && st.error) || 'request budget used up';
      await J.markNeedsAttention(jobKey, why);
      out = { ok: false, needsAttention: true, error: why };
    }

    if (out.ok) {
      item.status = 'completed';
      await J.recordOutcome(true);
    } else {
      item.status = 'error';
      const breaker = await J.recordOutcome(false);
      notifyPopup('generationError', { message: `Prompt ${i + 1}: ${out.error}` });
      if (breaker.tripped) {
        notifyPopup('generationError', { message: `Run halted: ${breaker.consecutive} jobs in a row failed (limit ${breaker.limit}).` });
        isRunning = false;
      }
    }
    if (item._pipelineRecordId && globalThis.bulkygenPipeline) {
      try {
        globalThis.bulkygenPipeline.deliverGenerationResult(item.id, out.ok
          ? { success: true, imageData: out.images[0].imageData, multipleImages: out.images, meta: out.images[0].meta, reused: !!out.reused }
          : { success: false, error: out.error, noRetry: !!out.needsAttention });
      } catch (e) { /* ignore */ }
    }
    await ext.storage.local.set({ queue });
    notifyPopup('updateQueue', { queue });
    if (!isRunning) break;
  }
  await ext.storage.local.set({ queue });
}

function flowJobKeyFor(item) {
  return item && item._pipelineRecordId ? `rec:${item._pipelineRecordId}` : (item && item.id);
}

async function runFlowSequentialGeneration(queue, delay, stillMine) {
  if (typeof stillMine !== 'function') stillMine = () => isRunning;
  const J = globalThis.bulkygenJobs;
  if (!J) throw new Error('Job ledger module is not loaded (modules/job-ledger.js)');

  for (let i = 0; i < queue.length && stillMine(); i++) {
    if (queue[i].status === 'completed') continue;

    await waitWhilePaused();
    if (!stillMine()) break;

    queue[i].status = 'processing';
    await ext.storage.local.set({ queue, currentIndex: i });
    notifyPopup('updateQueue', { queue });

    const jobKey = flowJobKeyFor(queue[i]);
    markLoopProgress('flow_job');
    const out = await runFlowJob(queue[i], jobKey, stillMine);

    if (out.aborted) {
      // Superseded or stopped: leave the item as it is; do not report a failure.
      await ext.storage.local.set({ queue });
      return;
    }

    if (out.ok) {
      queue[i].status = 'completed';
      await J.recordOutcome(true);
      try { globalThis.bulkygenToolLink?.publishResult(queue[i], out.images); } catch (e) { /* ignore */ }
      if (queue[i]._pipelineRecordId && globalThis.bulkygenPipeline) {
        try {
          globalThis.bulkygenPipeline.deliverGenerationResult(queue[i].id, {
            success: true,
            imageData: out.images[0] && out.images[0].imageData,
            multipleImages: out.images,
            meta: out.images[0] && out.images[0].meta,
            reused: !!out.reused
          });
        } catch (e) { /* ignore */ }
      }
    } else {
      queue[i].status = 'error';
      const breaker = await J.recordOutcome(false);
      logToExtension('warn', 'Flow', `Prompt ${i + 1} stopped: ${out.error}`);
      notifyPopup('generationError', { message: `Flow prompt ${i + 1}: ${out.error}` });
      if (queue[i]._pipelineRecordId && globalThis.bulkygenPipeline) {
        try {
          globalThis.bulkygenPipeline.deliverGenerationResult(queue[i].id, {
            success: false,
            error: out.error,
            // The ledger already spent (or refused) its budget. Retrying the
            // whole record would only repeat the same refusal.
            noRetry: !!out.needsAttention
          });
        } catch (e) { /* ignore */ }
      }
      if (out.fatalDisconnect) {
        notifyPopup('generationError', { message: 'Content script not loaded. Please refresh the Flow project page and try again.' });
        isRunning = false;
        break;
      }
      if (breaker.tripped) {
        const msg = `Run halted: ${breaker.consecutive} jobs in a row failed (limit ${breaker.limit}). Fix the cause (Flow tab, quota, selectors), then press Start - nothing further was submitted.`;
        logToExtension('error', 'Flow', msg);
        notifyPopup('generationError', { message: msg });
        isRunning = false;
        break;
      }
    }

    await ext.storage.local.set({ queue });
    notifyPopup('updateQueue', { queue });
  }
  await ext.storage.local.set({ queue });
}
async function regenerateSingleItem(itemId) {
  if (!itemId) return;
  if (isRunning) {
    throw new Error('Generation is already running');
  }

  isRunning = true;
  await ext.storage.local.set({ isRunning: true });

  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;
  let currentProvider = 'unknown';

  try {
    const res = await ext.tabs.sendMessage(currentTabId, { action: 'checkPage' });
    if (!res || !res.isSupportedPage) throw new Error('Unsupported page');
    currentProvider = res.provider || 'unknown';
  } catch {
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
    throw new Error('Please navigate to a supported page (Flow, Digen, Meta AI, or Grok) before regenerating.');
  }

  const data = await ext.storage.local.get(['queue', 'delay']);
  const queue = data.queue || [];
  const idx = queue.findIndex(q => q.id === itemId);
  if (idx === -1) {
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
    return;
  }

  // Tab activation removed to support background execution
  // Content script handles keep-alive

  queue[idx].status = 'processing';
  await ext.storage.local.set({ queue, currentIndex: idx });
  notifyPopup('updateQueue', { queue });

  // The user explicitly asked to pay for this prompt again: release its guard
  // (a fresh, visible submit budget) instead of letting the ledger refuse it.
  const regenKey = flowJobKeyFor(queue[idx]);
  try { await globalThis.bulkygenJobs?.release(regenKey); } catch (e) { /* ignore */ }

  try {
    await ensureTabContentScript(currentTabId);
    const response = await ext.tabs.sendMessage(currentTabId, {
      action: currentProvider === 'flow' ? 'flowSubmitPrompt' : 'generateImage',
      prompt: queue[idx].prompt,
      itemId: queue[idx].id,
      jobKey: regenKey,
      aspectRatio: queue[idx].aspectRatio || null
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Generation failed');
    }

    if (currentProvider !== 'flow') {
      // Save image/video data if provided
      // For Meta AI: handle multiple videos
      if (response.multipleVideos && Array.isArray(response.multipleVideos)) {
        console.log(`📹 Saving ${response.multipleVideos.length} Meta AI videos...`);
        for (let videoIdx = 0; videoIdx < response.multipleVideos.length; videoIdx++) {
          const videoData = response.multipleVideos[videoIdx];
          try {
            await saveGeneratedImage(
              videoData.imageData,
              `${queue[idx].prompt} (Video ${videoIdx + 1}/${response.multipleVideos.length})`,
              queue[idx].id,
              videoData.meta
            );
          } catch (saveError) {
            console.error(`Video ${videoIdx + 1} save error (continuing):`, saveError);
          }
        }
      } else if (response.imageData) {
        // Single image/video for other providers
        try {
          await saveGeneratedImage(response.imageData, queue[idx].prompt, queue[idx].id, response.meta);
        } catch (saveError) {
          console.error('Image save error (continuing):', saveError);
          notifyPopup('imageSaveError', {
            message: saveError?.message || 'Failed to save image data (continuing)'
          });
        }
      }
    } else {
      // Flow: save ALL captured images (x2 / x4 produce multiple)
      const flowImgs = Array.isArray(response.multipleImages) && response.multipleImages.length
        ? response.multipleImages
        : (response.imageData ? [{ imageData: response.imageData, meta: response.meta }] : []);
      for (let n = 0; n < flowImgs.length; n++) {
        try {
          const label = flowImgs.length > 1
            ? `${queue[idx].prompt} (${n + 1}/${flowImgs.length})`
            : queue[idx].prompt;
          await saveGeneratedImage(flowImgs[n].imageData, label, queue[idx].id, flowImgs[n].meta);
        } catch (saveError) {
          console.error('Flow image save error (continuing):', saveError);
        }
      }
    }

    queue[idx].status = 'completed';
    await ext.storage.local.set({ queue });
    notifyPopup('updateQueue', { queue });
  } catch (error) {
    queue[idx].status = 'error';
    await ext.storage.local.set({ queue });
    notifyPopup('updateQueue', { queue });
    throw error;
  } finally {
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
  }
}