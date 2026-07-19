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
     * Mark a record as 'processing' so another extension instance doesn't pick it up.
     *
     * @param {Object} cfg
     * @param {string|number} id — record primary key value
     * @returns {Promise<void>}
     */
    async function markProcessing(cfg, id) {
        await _patch(cfg, id, { 
            status: 'processing',
            updated_at: new Date().toISOString()
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
        await _patch(cfg, id, {
            status: 'failed',
            error_message: errorMsg || 'Unknown error',
            updated_at: new Date().toISOString()
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
            watermarkEnabled: meta.watermark?.enabled || false,
            watermarkText: meta.watermark?.text || null,
            watermarkLogoUrl: meta.watermark?.logo || null,
            watermarkOpacity: meta.watermark?.opacity || null,
            watermarkPosition: meta.watermark?.position || null,
            watermarkRotation: meta.watermark?.rotation || null,
            watermarkFont: meta.watermark?.font || null,
            watermarkScale: meta.watermark?.scale || null,
            watermarkMargin: meta.watermark?.margin || null,

            // Generation settings
            genQuality: meta.output?.quality || null,

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
        fetchPendingCount,
        markProcessing,
        updateRecord,
        markFailed,
        reclaimStuckRecords,
        testConnection,
        normalizeRecord
    };
})();
