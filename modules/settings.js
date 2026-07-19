/**
 * BulkyGen Settings Module
 * Central settings manager: load/save all configuration from chrome.storage.local.
 * All new features read their config from here — no magic hardcoded values.
 *
 * PRE-CONFIGURED SUPABASE CREDENTIALS:
 * Set `preconfiguredUrl` and `preconfiguredAnonKey` below to hard-code credentials
 * into the extension. Users on 'Pre-configured Settings' mode will use these.
 * Switch users to 'Manual Configuration' mode to let them supply their own.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'bulkygen_settings';

    /**
     * Default settings. Extend this object to add new fields — defaults are
     * automatically applied on first run or when a new field is added.
     */
    function defaultSettings() {
        return {
            // --- Configuration Mode ---
            configMode: 'preconfigured',  // 'preconfigured' or 'manual'

            // --- Pre-configured Credentials (Hardcoded) ---
            // ============================================================
            // SET YOUR SUPABASE CREDENTIALS HERE for 'Pre-configured' mode
            // ============================================================
            preconfiguredUrl: 'https://hqxoftkmkcnwpnzwanuf.supabase.co',
            preconfiguredAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhxeG9mdGtta2Nud3BuendhbnVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNTMyMTIsImV4cCI6MjA5ODcyOTIxMn0.1R6ZUF2G4eRAkPP5HkdMcgMyhVif-qDfdL95TFUAOiI',
            preconfiguredTable: 'images_queue',   // ← hardcoded, never editable by the user

            // --- Manual Credentials ---
            supabaseUrl: '',             // e.g. https://xxxx.supabase.co
            supabaseAnonKey: '',         // public anon key

            // --- Common Supabase ---
            supabaseTable: 'images_queue', // table to poll for pending records (manual mode)
            pollIntervalMs: 5000,          // how often to fetch next pending record

            // --- Device Tracking ---
            deviceName: '',              // Will be auto-populated if empty

            // Generation settings columns
            col_gen_quality: 'gen_quality',   // flow model / quality setting


            // --- Image Processing ---
            jpegQuality: 0.90,        // 0.80 | 0.85 | 0.90 | 0.95 | 1.00
            maxRetries: 5,           // per record, before marking as failed
            retryBaseMs: 2000,        // base delay for exponential backoff
            retryMaxMs: 60000,       // cap on backoff delay

            // --- Google Drive ---
            driveEnabled: false,
            driveFolderId: '',        // root target folder ID
            driveAutoFolder: true,      // create subfolders automatically
            driveNamingTemplate: '{index}-{date}',  // file naming tokens

            // --- Flow Generator ---
            flowProjectId: '',          // auto-detected from active tab, or manual

            // --- Autonomous mode ---
            autonomousMode: false,      // true = ignore manual queue, poll Supabase
            pauseOnError: false,        // stop polling when a record fails

            // --- Global Watermark Defaults ---
            // Applied when a Supabase record does not supply per-record watermark fields.
            watermarkEnabled: false,
            watermarkText: '',
            watermarkLogoUrl: '',
            watermarkOpacity: 0.3,
            watermarkPosition: 'bottom-right',
            watermarkRotation: 0,
            watermarkFont: '24px sans-serif',
            watermarkScale: 1.0,
            watermarkMargin: 20,

            // --- Global Metadata Embedding Defaults ---
            // Applied when a Supabase record does not supply per-record metadata fields.
            metadataEnabled: true,
            metadataTitle: '',
            metadataDescription: '',
            metadataKeywords: '',
            metadataAuthor: '',
            metadataCopyright: '',
            metadataWebsite: '',

            // --- Debug ---
            logLevel: 'info',           // verbose | info | warn | error
            debugMode: false
        };
    }

    let _settings = null;

    async function _load() {
        const ChromeOrBrowser = globalThis.chrome || globalThis.browser;
        if (!ChromeOrBrowser?.storage?.local) { _settings = defaultSettings(); return; }
        await new Promise((res, rej) => {
            ChromeOrBrowser.storage.local.get([STORAGE_KEY], (data) => {
                const err = ChromeOrBrowser.runtime?.lastError;
                if (err) { _settings = defaultSettings(); res(); return; }
                _settings = Object.assign(defaultSettings(), data[STORAGE_KEY] || {});
                res();
            });
        });
    }

    async function _save() {
        const ChromeOrBrowser = globalThis.chrome || globalThis.browser;
        if (!ChromeOrBrowser?.storage?.local) return;
        await new Promise((res, rej) => {
            ChromeOrBrowser.storage.local.set({ [STORAGE_KEY]: _settings }, () => {
                const err = ChromeOrBrowser.runtime?.lastError;
                err ? rej(new Error(err.message)) : res();
            });
        });
    }

    async function _ensure() { if (!_settings) await _load(); }

    const settings = {
        async load() { await _load(); },

        /** Get a snapshot of all settings (clone), with active credentials resolved. */
        async get() {
            await _ensure();
            const snap = Object.assign({}, _settings);
            // When in preconfigured mode, overlay the hardcoded table so all
            // downstream modules (supabase.js, pipeline.js) use the right value
            // without needing their own mode-check logic.
            if (snap.configMode === 'preconfigured') {
                snap.supabaseUrl = snap.preconfiguredUrl;
                snap.supabaseAnonKey = snap.preconfiguredAnonKey;
                snap.supabaseTable = snap.preconfiguredTable || 'images_queue';
            }
            return snap;
        },

        /** Get a single setting value. */
        async getKey(key) { await _ensure(); return _settings[key]; },

        /** Update one or more settings keys and persist. */
        async set(updates) {
            await _ensure();
            Object.assign(_settings, updates);
            await _save();
        },

        /** Reset all settings to defaults. */
        async reset() {
            _settings = defaultSettings();
            await _save();
        },

        /**
         * Check whether the minimum required Supabase settings are configured.
         */
        async isSupabaseConfigured() {
            await _ensure();
            if (_settings.configMode === 'preconfigured') {
                return !!(_settings.preconfiguredUrl && _settings.preconfiguredAnonKey && _settings.preconfiguredTable);
            }
            return !!(_settings.supabaseUrl && _settings.supabaseAnonKey && _settings.supabaseTable);
        },

        /**
         * Check whether the minimum required Drive settings are configured.
         */
        async isDriveConfigured() {
            await _ensure();
            return !!(_settings.driveEnabled && _settings.driveFolderId);
        }
    };

    globalThis.bulkygenSettings = settings;
})();
