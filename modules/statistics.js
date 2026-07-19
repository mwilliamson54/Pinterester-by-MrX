/**
 * BulkyGen Statistics Module
 * Tracks processing stats with daily auto-reset.
 * Persists in chrome.storage.local under 'bulkygen_stats'.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'bulkygen_stats';

    /**
     * Default stats structure. All counters reset-able, lifetime ones never.
     */
    function defaultStats() {
        return {
            // Daily counters — reset when the calendar date changes
            processedToday: 0,
            failedToday: 0,
            uploadedToday: 0,
            lastResetDate: new Date().toDateString(),

            // Lifetime counters — never reset
            processedLifetime: 0,
            failedLifetime: 0,

            // Timing accumulators (milliseconds)
            totalProcessingTimeMs: 0,
            totalUploadTimeMs: 0,
            processingCount: 0,   // number of samples for averaging
            uploadCount: 0,

            // Current run snapshot
            currentQueue: 0,
            currentPrompt: '',
            currentStatus: 'idle',    // idle | waiting | generating | uploading | completed | error
            lastCompletedAt: null,    // ISO string
            lastImageMeta: null,      // { driveUrl, thumbnail, prompt } of last uploaded image
            lastError: null,          // error message string

            // Installation baseline
            installedAt: Date.now()
        };
    }

    let _stats = null;

    function _todayStr() { return new Date().toDateString(); }

    /**
     * Reset daily counters if the calendar date has changed.
     */
    function _maybeDailyReset(s) {
        if (s.lastResetDate !== _todayStr()) {
            s.processedToday = 0;
            s.failedToday = 0;
            s.uploadedToday = 0;
            s.lastResetDate = _todayStr();
        }
    }

    async function _save() {
        try {
            const storage = (globalThis.chrome || globalThis.browser)?.storage?.local;
            if (!storage) return;
            await new Promise((res, rej) => storage.set({ [STORAGE_KEY]: _stats }, () => {
                const err = (globalThis.chrome || globalThis.browser)?.runtime?.lastError;
                err ? rej(new Error(err.message)) : res();
            }));
        } catch (e) { /* non-fatal */ }
    }

    async function _load() {
        try {
            const storage = (globalThis.chrome || globalThis.browser)?.storage?.local;
            if (!storage) { _stats = defaultStats(); return; }
            const data = await new Promise((res, rej) => storage.get([STORAGE_KEY], (d) => {
                const err = (globalThis.chrome || globalThis.browser)?.runtime?.lastError;
                err ? rej(new Error(err.message)) : res(d);
            }));
            _stats = Object.assign(defaultStats(), data[STORAGE_KEY] || {});
            _maybeDailyReset(_stats);
        } catch (e) {
            _stats = defaultStats();
        }
    }

    async function _ensureLoaded() {
        if (!_stats) await _load();
    }

    const statistics = {
        async load() { await _load(); },

        async get() {
            await _ensureLoaded();
            _maybeDailyReset(_stats);
            return Object.assign({}, _stats);
        },

        async recordProcessed(durationMs) {
            await _ensureLoaded();
            _maybeDailyReset(_stats);
            _stats.processedToday++;
            _stats.processedLifetime++;
            _stats.totalProcessingTimeMs += (durationMs || 0);
            _stats.processingCount++;
            _stats.lastCompletedAt = new Date().toISOString();
            await _save();
        },

        async recordFailed() {
            await _ensureLoaded();
            _maybeDailyReset(_stats);
            _stats.failedToday++;
            _stats.failedLifetime++;
            await _save();
        },

        async recordUploaded(durationMs) {
            await _ensureLoaded();
            _maybeDailyReset(_stats);
            _stats.uploadedToday++;
            _stats.totalUploadTimeMs += (durationMs || 0);
            _stats.uploadCount++;
            await _save();
        },

        async setStatus(status, prompt) {
            await _ensureLoaded();
            _stats.currentStatus = status;
            if (prompt !== undefined) _stats.currentPrompt = prompt;
            await _save();
        },

        async setQueueSize(n) {
            await _ensureLoaded();
            _stats.currentQueue = n;
            await _save();
        },

        async setLastImage(meta) {
            await _ensureLoaded();
            _stats.lastImageMeta = meta;
            await _save();
        },

        async setLastError(msg) {
            await _ensureLoaded();
            _stats.lastError = msg;
            await _save();
        },

        /** Derived: average generation time in ms (or 0 if no samples). */
        async avgProcessingMs() {
            await _ensureLoaded();
            return _stats.processingCount > 0
                ? Math.round(_stats.totalProcessingTimeMs / _stats.processingCount)
                : 0;
        },

        /** Derived: average upload time in ms (or 0). */
        async avgUploadMs() {
            await _ensureLoaded();
            return _stats.uploadCount > 0
                ? Math.round(_stats.totalUploadTimeMs / _stats.uploadCount)
                : 0;
        },

        /** Estimated completion time in ms based on queue size and avg time. */
        async estimatedCompletionMs() {
            await _ensureLoaded();
            const avg = _stats.processingCount > 0
                ? _stats.totalProcessingTimeMs / _stats.processingCount : 30000;
            return Math.round(_stats.currentQueue * avg);
        }
    };

    globalThis.bulkygenStatistics = statistics;
})();
