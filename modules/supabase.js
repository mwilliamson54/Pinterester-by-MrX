/**
 * BulkyGen Supabase Module
 * REST API client for fetching pending prompts and updating records.
 * Uses only fetch() — no Supabase SDK required.
 *
 * Column names are read from bulkygenSettings so the schema is configurable
 * without touching this file.
 */
(function () {
    'use strict';

    /**
     * Fetch a single pending record from Supabase.
     * Returns the first record where status = 'pending', ordered by id asc.
     * Returns null if no records found.
     * Throws on network/API errors.
     *
     * @param {Object} cfg — { supabaseUrl, supabaseAnonKey, supabaseTable, col_* }
     * @returns {Promise<Object|null>}
     */
    async function fetchPendingRecord(cfg) {
        const { supabaseUrl, supabaseAnonKey, supabaseTable } = cfg;

        if (!supabaseUrl || !supabaseAnonKey || !supabaseTable) {
            throw new Error('Supabase not configured (missing URL, key, or table name)');
        }

        const baseUrl = supabaseUrl.replace(/\/$/, '');
        const url = `${baseUrl}/rest/v1/${encodeURIComponent(supabaseTable)}` +
            `?status=eq.pending` +
            `&select=*` +
            `&order=id.asc` +
            `&limit=1`;

        const response = await fetch(url, {
            method: 'GET',
            headers: _headers(supabaseAnonKey)
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Supabase fetch failed (${response.status}): ${body}`);
        }

        const rows = await response.json();
        return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    }

    /**
     * Atomically claim the next pending record: find the oldest pending row,
     * then flip it to 'processing' in a single PATCH that only matches (and
     * updates) the row if it is STILL status='pending' at that instant
     * (status=eq.pending is part of the same request as id=eq.X). If another
     * worker claimed it a moment earlier, zero rows match, the response comes
     * back empty, and this function moves on to the next candidate instead of
     * processing the same record twice.
     *
     * @param {Object} cfg
     * @param {number} [maxAttempts=5] — how many candidate records to try before giving up
     * @returns {Promise<Object|null>} the claimed record (already marked 'processing'), or null if nothing could be claimed
     */
    async function claimPendingRecord(cfg, maxAttempts = 5) {
        const { supabaseUrl, supabaseAnonKey, supabaseTable } = cfg;
        if (!supabaseUrl || !supabaseAnonKey || !supabaseTable) {
            throw new Error('Supabase not configured (missing URL, key, or table name)');
        }

        const baseUrl = supabaseUrl.replace(/\/$/, '');
        const deviceStr = cfg.deviceName || (globalThis.navigator && globalThis.navigator.userAgent) || 'Unknown Device';
        const triedIds = new Set();

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // 1) Find a candidate pending record (skip ones we already failed to claim this round)
            const excludeClause = triedIds.size > 0
                ? `&id=not.in.(${[...triedIds].join(',')})`
                : '';
            const findUrl = `${baseUrl}/rest/v1/${encodeURIComponent(supabaseTable)}` +
                `?status=eq.pending` +
                excludeClause +
                `&select=*` +
                `&order=id.asc` +
                `&limit=1`;

            const findResponse = await fetch(findUrl, {
                method: 'GET',
                headers: _headers(supabaseAnonKey)
            });

            if (!findResponse.ok) {
                const body = await findResponse.text().catch(() => '');
                throw new Error(`Supabase fetch failed (${findResponse.status}): ${body}`);
            }

            const rows = await findResponse.json();
            const candidate = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
            if (!candidate) return null; // nothing left to claim

            triedIds.add(candidate.id);

            // 2) Claim it — this only succeeds if status is still 'pending' right now.
            const claimUrl = `${baseUrl}/rest/v1/${encodeURIComponent(supabaseTable)}` +
                `?id=eq.${encodeURIComponent(candidate.id)}` +
                `&status=eq.pending`;

            const claimResponse = await fetch(claimUrl, {
                method: 'PATCH',
                headers: { ..._headers(supabaseAnonKey), 'Prefer': 'return=representation' },
                body: JSON.stringify({
                    status: 'processing',
                    updated_at: new Date().toISOString(),
                    generated_by: deviceStr,
                    worker_id: deviceStr
                })
            });

            if (!claimResponse.ok) {
                const body = await claimResponse.text().catch(() => '');
                throw new Error(`Supabase claim failed (${claimResponse.status}): ${body}`);
            }

            const claimedRows = await claimResponse.json().catch(() => []);
            if (Array.isArray(claimedRows) && claimedRows.length > 0) {
                return claimedRows[0]; // we won the race — this row is now ours
            }
            // Someone else claimed it first — loop and try the next candidate
        }

        return null; // gave up after maxAttempts without winning a claim
    }

    /**
     * Mark a record as 'processing' so another extension instance doesn't pick it up.
     *
     * @param {Object} cfg
     * @param {string|number} id — record primary key value
     * @returns {Promise<void>}
     */
    async function markProcessing(cfg, id) {
		const deviceStr = cfg.deviceName || (globalThis.navigator && globalThis.navigator.userAgent) || 'Unknown Device';
        await _patch(cfg, id, {
            status: 'processing',
            updated_at: new Date().toISOString(),
            generated_by: deviceStr,
            worker_id: deviceStr
        });
    }

    /**
     * Update a record after successful processing + upload.
     * Only sends fields that are actually provided (no null overwrites).
     *
     * @param {Object} cfg
     * @param {string|number} id
     * @param {Object} fields — subset of the update schema
     * @returns {Promise<void>}
     */
    async function updateRecord(cfg, id, fields) {
        // Strip undefined values so we never overwrite with null accidentally
        const clean = {};
        for (const [k, v] of Object.entries(fields)) {
            if (v !== undefined) clean[k] = v;
        }
        if (Object.keys(clean).length === 0) return;
        await _patch(cfg, id, clean);
    }

    /**
     * Reclaim records stuck at status='processing' for longer than staleMinutes.
     * This happens when the MV3 service worker is killed mid-generation — the
     * record was claimed (status=processing) but the code that would eventually
     * mark it completed/failed never got to run again, since fetchPendingRecord()
     * only ever looks at status='pending'. Without this sweep those rows are
     * silently lost forever. Call once when the pipeline starts (and optionally
     * on a slow interval, e.g. every 10 minutes, while it runs).
     *
     * @param {Object} cfg
     * @param {number} [staleMinutes=10]
     * @returns {Promise<number>} number of records reclaimed
     */
    async function reclaimStuckRecords(cfg, staleMinutes = 10) {
        const { supabaseUrl, supabaseAnonKey, supabaseTable } = cfg;
        if (!supabaseUrl || !supabaseAnonKey || !supabaseTable) return 0;

        const baseUrl = supabaseUrl.replace(/\/$/, '');
        const cutoff = new Date(Date.now() - staleMinutes * 60000).toISOString();
        const url = `${baseUrl}/rest/v1/${encodeURIComponent(supabaseTable)}` +
            `?status=eq.processing&updated_at=lt.${encodeURIComponent(cutoff)}`;

        const response = await fetch(url, {
            method: 'PATCH',
            headers: { ..._headers(supabaseAnonKey), 'Prefer': 'return=representation' },
            body: JSON.stringify({
                status: 'pending',
                error_message: 'Reclaimed: stuck in processing (worker likely restarted mid-run)',
                updated_at: new Date().toISOString()
            })
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Reclaim stuck records failed (${response.status}): ${body}`);
        }

        const rows = await response.json().catch(() => []);
        return Array.isArray(rows) ? rows.length : 0;
    }

    /**
     * Mark a record as 'failed' with an error message.
     *
     * @param {Object} cfg
     * @param {string|number} id
     * @param {string} errorMsg
     * @returns {Promise<void>}
     */
    async function markFailed(cfg, id, errorMsg) {
		const deviceStr = cfg.deviceName || (globalThis.navigator && globalThis.navigator.userAgent) || 'Unknown Device';
        await _patch(cfg, id, {
            status: 'failed',
            error_message: errorMsg || 'Unknown error',
            updated_at: new Date().toISOString(),
            generated_by: deviceStr,
            worker_id: deviceStr
        });
    }

    /**
     * Test the Supabase connection. Returns { ok, error }.
     *
     * @param {Object} cfg
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async function testConnection(cfg) {
        try {
            const { supabaseUrl, supabaseAnonKey, supabaseTable } = cfg;
            if (!supabaseUrl || !supabaseAnonKey || !supabaseTable) {
                return { ok: false, error: 'Missing URL, anon key, or table name' };
            }
            const baseUrl = supabaseUrl.replace(/\/$/, '');
            const url = `${baseUrl}/rest/v1/${encodeURIComponent(supabaseTable)}?limit=1&select=id`;
            const response = await fetch(url, {
                method: 'GET',
                headers: _headers(supabaseAnonKey)
            });
            if (response.ok || response.status === 200) return { ok: true };
            const body = await response.text().catch(() => '');
            return { ok: false, error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------

    function _headers(anonKey) {
        return {
            'apikey': anonKey,
            'Authorization': `Bearer ${anonKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        };
    }

    async function _patch(cfg, id, body) {
        const { supabaseUrl, supabaseAnonKey, supabaseTable } = cfg;
        const baseUrl = supabaseUrl.replace(/\/$/, '');
        const url = `${baseUrl}/rest/v1/${encodeURIComponent(supabaseTable)}?id=eq.${encodeURIComponent(id)}`;

        const response = await fetch(url, {
            method: 'PATCH',
            headers: _headers(supabaseAnonKey),
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const bodyText = await response.text().catch(() => '');
            throw new Error(`Supabase update failed (${response.status}): ${bodyText.slice(0, 300)}`);
        }
    }

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /**
     * Extract all relevant columns from a raw Supabase record, using the
     * column name mappings from settings config. Safe — won't throw on missing cols.
     *
     * @param {Object} record — raw row from Supabase
     * @param {Object} cfg — settings config with col_* keys
     * @returns {Object} — normalized prompt record
     */
    function normalizeRecord(record) {
        const meta = record.metadata || {};
        return {
            id: record.id,
            status: record.status,
            prompt: record.prompt,
            attempts: record.attempts || 0,
            
            title: (meta.seo && meta.seo.title) || meta.title || null,
            description: (meta.seo && meta.seo.description) || meta.description || null,
            keywords: (meta.seo && meta.seo.keywords) || meta.keywords || null,
            author: (meta.rights && meta.rights.creator) || meta.author || null,
            copyright: (meta.rights && meta.rights.copyright_notice) || meta.copyright || null,
            website: (meta.rights && meta.rights.website) || meta.website || null,
            filename: (meta.seo && meta.seo.filename) || null,
            folder: meta.folder || null,

            // Watermark options
            watermarkEnabled: (meta.watermark_enabled !== undefined) ? meta.watermark_enabled :
                               (meta.watermarkEnabled !== undefined) ? meta.watermarkEnabled :
                               (typeof meta.watermark === 'boolean') ? meta.watermark :
                               (meta.watermark && meta.watermark.enabled !== undefined) ? meta.watermark.enabled :
                               (meta.watermark === false) ? false :
                               undefined,
            watermarkText: meta.watermark_text !== undefined ? meta.watermark_text :
                           meta.watermarkText !== undefined ? meta.watermarkText :
                           meta.watermark?.text !== undefined ? meta.watermark.text :
                           undefined,
            watermarkLogoUrl: meta.watermark_logo_url !== undefined ? meta.watermark_logo_url :
                              meta.watermark_logo !== undefined ? meta.watermark_logo :
                              meta.watermarkLogoUrl !== undefined ? meta.watermarkLogoUrl :
                              meta.watermark?.logoUrl !== undefined ? meta.watermark.logoUrl :
                              meta.watermark?.logo !== undefined ? meta.watermark.logo :
                              undefined,
            watermarkOpacity: meta.watermark_opacity !== undefined ? meta.watermark_opacity :
                              meta.watermarkOpacity !== undefined ? meta.watermarkOpacity :
                              meta.watermark?.opacity !== undefined ? meta.watermark.opacity :
                              undefined,
            watermarkPosition: meta.watermark_position !== undefined ? meta.watermark_position :
                               meta.watermarkPosition !== undefined ? meta.watermarkPosition :
                               meta.watermark?.position !== undefined ? meta.watermark.position :
                               undefined,
            watermarkRotation: meta.watermark_rotation !== undefined ? meta.watermark_rotation :
                               meta.watermarkRotation !== undefined ? meta.watermarkRotation :
                               meta.watermark?.rotation !== undefined ? meta.watermark.rotation :
                               undefined,
            watermarkFont: meta.watermark_font !== undefined ? meta.watermark_font :
                           meta.watermarkFont !== undefined ? meta.watermarkFont :
                           meta.watermark?.font !== undefined ? meta.watermark.font :
                           undefined,
            watermarkScale: meta.watermark_scale !== undefined ? meta.watermark_scale :
                            meta.watermarkScale !== undefined ? meta.watermarkScale :
                            meta.watermark?.scale !== undefined ? meta.watermark.scale :
                            undefined,
            watermarkMargin: meta.watermark_margin !== undefined ? meta.watermark_margin :
                             meta.watermarkMargin !== undefined ? meta.watermarkMargin :
                             meta.watermark?.margin !== undefined ? meta.watermark.margin :
                             undefined,

            // Metadata options
            metadataEnabled: (meta.metadata_enabled !== undefined) ? meta.metadata_enabled :
                             (meta.metadataEnabled !== undefined) ? meta.metadataEnabled :
                             (meta.metadata_written !== undefined) ? meta.metadata_written :
                             (meta.metadataWritten !== undefined) ? meta.metadataWritten :
                             (meta.metadata && meta.metadata.enabled !== undefined) ? meta.metadata.enabled :
                             undefined,

            // Generation settings
            genQuality: meta.output?.quality || null,
            // Aspect ratio to select in Flow before submitting, e.g. "16:9",
            // "4:3", "1:1", "3:4", "9:16". Accepts either a top-level
            // aspect_ratio/aspectRatio column or one nested under output/metadata.
            aspectRatio: record.aspect_ratio !== undefined ? record.aspect_ratio :
                         record.aspectRatio !== undefined ? record.aspectRatio :
                         meta.aspect_ratio !== undefined ? meta.aspect_ratio :
                         meta.aspectRatio !== undefined ? meta.aspectRatio :
                         meta.output?.aspect_ratio !== undefined ? meta.output.aspect_ratio :
                         meta.output?.aspectRatio !== undefined ? meta.output.aspectRatio :
                         null,

            // Preserve entire raw record for forward compatibility
            _raw: record
        };
    }

    /**
     * Fetch the count of pending records without loading row data.
     * Uses PostgREST's `Prefer: count=exact` to get the total.
     *
     * @param {Object} cfg
     * @returns {Promise<number>} count of pending records (0 on error)
     */
    async function fetchPendingCount(cfg) {
        try {
            const { supabaseUrl, supabaseAnonKey, supabaseTable } = cfg;
            if (!supabaseUrl || !supabaseAnonKey || !supabaseTable) return 0;
            const baseUrl = supabaseUrl.replace(/\/$/, '');
            const url = `${baseUrl}/rest/v1/${encodeURIComponent(supabaseTable)}?status=eq.pending&select=id&limit=1000`;
            const response = await fetch(url, {
                method: 'HEAD',
                headers: {
                    ..._headers(supabaseAnonKey),
                    'Prefer': 'count=exact'
                }
            });
            if (!response.ok) return 0;
            const contentRange = response.headers.get('Content-Range') || '';
            // Content-Range: 0-0/42  → total = 42
            const match = contentRange.match(/\/(\d+)/);
            return match ? parseInt(match[1], 10) : 0;
        } catch (e) {
            return 0;
        }
    }

    globalThis.bulkygenSupabase = {
        fetchPendingRecord,
        claimPendingRecord,
        fetchPendingCount,
        markProcessing,
        updateRecord,
        markFailed,
        reclaimStuckRecords,
        testConnection,
        normalizeRecord
    };
})();