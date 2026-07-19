/**
 * BulkyGen Settings Page — Main Logic
 * Loads settings from chrome.storage.local, renders them, saves on form submit.
 * Uses the bulkygenSettings and bulkygenSupabase modules (already loaded via <script>).
 */
(async function () {
    'use strict';

    // ── Field ID → settings key mapping  ────────────────────────────────────
    const FIELD_MAP = [
        // Supabase (manual-only credentials — table/URL/key saved only from manual fields)
        ['supabaseUrl', 'supabaseUrl'],
        ['supabaseAnonKey', 'supabaseAnonKey'],
        ['supabaseTable', 'supabaseTable'],
        // pollIntervalMs is the single stored key; two UI inputs mirror each other
        ['pollIntervalMs', 'pollIntervalMs'],

        // Configuration Mode
        ['configMode', 'configMode'],
        ['deviceName', 'deviceName'],

        // Autonomous mode
        ['autonomousMode', 'autonomousMode'],
        ['pauseOnError', 'pauseOnError'],
        ['maxRetries', 'maxRetries'],
        ['retryBaseMs', 'retryBaseMs'],
        ['retryMaxMs', 'retryMaxMs'],

        // Image processing
        ['jpegQuality', 'jpegQuality'],

        // Watermark
        ['watermarkEnabled', 'watermarkEnabled'],
        ['watermarkText', 'watermarkText'],
        ['watermarkLogoUrl', 'watermarkLogoUrl'],
        ['watermarkOpacity', 'watermarkOpacity'],
        ['watermarkPosition', 'watermarkPosition'],
        ['watermarkRotation', 'watermarkRotation'],
        ['watermarkFont', 'watermarkFont'],
        ['watermarkScale', 'watermarkScale'],
        ['watermarkMargin', 'watermarkMargin'],

        // Metadata Embedding
        ['metadataEnabled', 'metadataEnabled'],
        ['metadataTitle', 'metadataTitle'],
        ['metadataDescription', 'metadataDescription'],
        ['metadataKeywords', 'metadataKeywords'],
        ['metadataAuthor', 'metadataAuthor'],
        ['metadataCopyright', 'metadataCopyright'],
        ['metadataWebsite', 'metadataWebsite'],

        // Google Drive
        ['driveEnabled', 'driveEnabled'],
        ['driveFolderId', 'driveFolderId'],
        ['driveNamingTemplate', 'driveNamingTemplate'],
        ['driveAutoFolder', 'driveAutoFolder'],

        // Debug
        ['logLevel', 'logLevel'],
        ['debugMode', 'debugMode'],
    ];

    // ── Bootstrap ──────────────────────────────────────────────────────────
    await bulkygenSettings.load();
    const current = await bulkygenSettings.get();

    // ── Render current settings into the form ─────────────────────────────
    function renderSettings(s) {
        for (const [fieldId, key] of FIELD_MAP) {
            if (key === 'configMode') {
                const radio = document.querySelector(`input[name="configMode"][value="${s[key]}"]`);
                if (radio) radio.checked = true;
                continue;
            }

            const el = document.getElementById(fieldId);
            if (!el) continue;
            const val = s[key];
            if (el.type === 'checkbox') {
                el.checked = !!val;
            } else if (el.type === 'range') {
                el.value = val != null ? val : el.getAttribute('value') || 0.9;
                updateRangeDisplay(el);
            } else {
                el.value = val != null ? String(val) : '';
            }
        }
        // Sync the mirrored poll interval input in preconfigured view
        const preEl = document.getElementById('pollIntervalMsPre');
        if (preEl && s.pollIntervalMs != null) preEl.value = s.pollIntervalMs;
        updateConfigModeVisibility();
        updateDriveFieldsVisibility();
        updateWatermarkFieldsVisibility();
        updateMetadataFieldsVisibility();
    }

    renderSettings(current);

    // ── Config Mode visibility ───────────────────────────────────────────
    function updateConfigModeVisibility() {
        const mode = document.querySelector('input[name="configMode"]:checked')?.value || 'preconfigured';
        const manualDiv = document.getElementById('manualCredentials');
        const preconfDiv = document.getElementById('preconfiguredMsg');
        const preconfCommon = document.getElementById('preconfiguredCommon');
        if (manualDiv) manualDiv.style.display = mode === 'manual' ? 'block' : 'none';
        if (preconfDiv) preconfDiv.style.display = mode === 'preconfigured' ? 'block' : 'none';
        if (preconfCommon) preconfCommon.style.display = mode === 'preconfigured' ? 'block' : 'none';
    }

    document.querySelectorAll('input[name="configMode"]').forEach(radio => {
        radio.addEventListener('change', updateConfigModeVisibility);
    });

    // Sync the preconfigured poll interval mirror input → stored pollIntervalMs
    document.getElementById('pollIntervalMsPre')?.addEventListener('input', function () {
        const main = document.getElementById('pollIntervalMs');
        if (main) main.value = this.value;
    });

    // ── JPEG quality live display ─────────────────────────────────────────
    function updateRangeDisplay(slider) {
        const display = document.getElementById(slider.id + 'Val');
        if (!display) return;
        if (slider.id === 'watermarkScale') {
            display.textContent = parseFloat(slider.value).toFixed(2) + '\u00d7';
        } else {
            display.textContent = Math.round(parseFloat(slider.value) * 100) + '%';
        }
    }

    document.getElementById('jpegQuality')?.addEventListener('input', function () {
        updateRangeDisplay(this);
    });
    document.getElementById('watermarkOpacity')?.addEventListener('input', function () {
        updateRangeDisplay(this);
    });
    document.getElementById('watermarkScale')?.addEventListener('input', function () {
        updateRangeDisplay(this);
    });

    // ── Watermark fields visibility ───────────────────────────────────────
    function updateWatermarkFieldsVisibility() {
        const enabled = document.getElementById('watermarkEnabled')?.checked;
        const fields = document.getElementById('watermarkFields');
        if (fields) fields.style.opacity = enabled ? '1' : '0.45';
    }
    document.getElementById('watermarkEnabled')?.addEventListener('change', updateWatermarkFieldsVisibility);

    // ── Metadata fields visibility ────────────────────────────────────────
    function updateMetadataFieldsVisibility() {
        const enabled = document.getElementById('metadataEnabled')?.checked;
        const fields = document.getElementById('metadataFields');
        if (fields) fields.style.opacity = enabled ? '1' : '0.45';
    }
    document.getElementById('metadataEnabled')?.addEventListener('change', updateMetadataFieldsVisibility);

    // ── Drive fields visibility ───────────────────────────────────────────
    function updateDriveFieldsVisibility() {
        const enabled = document.getElementById('driveEnabled')?.checked;
        const fields = document.getElementById('driveFields');
        if (fields) fields.style.opacity = enabled ? '1' : '0.45';
    }
    document.getElementById('driveEnabled')?.addEventListener('change', updateDriveFieldsVisibility);


    // ── Toggle show/hide anon key ─────────────────────────────────────────
    document.getElementById('toggleAnonKey')?.addEventListener('click', () => {
        const input = document.getElementById('supabaseAnonKey');
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
    });

    // ── Collect form values into settings object ──────────────────────────
    function collectSettings() {
        const out = {};
        for (const [fieldId, key] of FIELD_MAP) {
            if (key === 'configMode') {
                out[key] = document.querySelector('input[name="configMode"]:checked')?.value || 'preconfigured';
                continue;
            }

            const el = document.getElementById(fieldId);
            if (!el) continue;
            if (el.type === 'checkbox') {
                out[key] = el.checked;
            } else if (el.type === 'range') {
                out[key] = parseFloat(el.value);
            } else if (el.type === 'number') {
                out[key] = el.value !== '' ? Number(el.value) : undefined;
            } else {
                out[key] = el.value.trim();
            }
        }
        return out;
    }

    // ── Save button ───────────────────────────────────────────────────────
    document.getElementById('saveBtn')?.addEventListener('click', async () => {
        const updates = collectSettings();

        // Validate required fields for manual mode
        if (updates.configMode === 'manual') {
            if (!updates.supabaseUrl?.trim()) {
                showSaveStatus('✗ Project URL is required in manual mode', 'err'); return;
            }
            if (!updates.supabaseAnonKey?.trim()) {
                showSaveStatus('✗ Anon Key is required in manual mode', 'err'); return;
            }
            if (!updates.supabaseTable?.trim()) {
                showSaveStatus('✗ Table Name is required in manual mode', 'err'); return;
            }
        }

        try {
            await bulkygenSettings.set(updates);
            showSaveStatus('✓ Saved', 'ok');
        } catch (e) {
            showSaveStatus('✗ ' + e.message, 'err');
        }
    });

    // ── Reset button ──────────────────────────────────────────────────────
    document.getElementById('resetBtn')?.addEventListener('click', async () => {
        if (!confirm('Reset all settings to defaults?')) return;
        await bulkygenSettings.reset();
        const fresh = await bulkygenSettings.get();
        renderSettings(fresh);
        showSaveStatus('↺ Reset to defaults', 'ok');
    });

    // ── Test Supabase connection ──────────────────────────────────────────
    document.getElementById('testSupabase')?.addEventListener('click', async () => {
        const btn = document.getElementById('testSupabase');
        const result = document.getElementById('supabaseTestResult');
        if (!btn || !result) return;

        btn.disabled = true;
        btn.textContent = '⏳ Testing...';
        result.textContent = '';
        result.className = 'test-result';

        const formValues = collectSettings();
        let cfg = {
            supabaseTable: formValues.supabaseTable
        };

        if (formValues.configMode === 'preconfigured') {
            const s = await bulkygenSettings.get();
            cfg.supabaseUrl = s.preconfiguredUrl;
            cfg.supabaseAnonKey = s.preconfiguredAnonKey;
        } else {
            cfg.supabaseUrl = formValues.supabaseUrl;
            cfg.supabaseAnonKey = formValues.supabaseAnonKey;
        }

        const { ok, error } = await bulkygenSupabase.testConnection(cfg);

        if (ok) {
            result.textContent = '✓ Connected';
            result.className = 'test-result pass';
        } else {
            result.textContent = '✗ ' + (error || 'Failed');
            result.className = 'test-result fail';
        }

        btn.disabled = false;
        btn.textContent = '🔌 Test Connection';
    });

    // ── Google Drive Auth State Management ────────────────────────────────
    const driveStatusText = document.getElementById('driveStatusText');
    const driveEmailText = document.getElementById('driveEmailText');
    const driveUserEmail = document.getElementById('driveUserEmail');
    const authDriveConnectBtn = document.getElementById('authDriveConnectBtn');
    const authDriveDisconnectBtn = document.getElementById('authDriveDisconnectBtn');
    const driveSettingsUI = document.getElementById('driveSettingsUI');

    async function updateDriveAuthState(interactive = false) {
        if (!authDriveConnectBtn) return;
        
        try {
            // Attempt to get token silently (or interactive if requested)
            const token = await bulkygenGoogleAuth.getAccessToken(interactive);
            if (token) {
                // Connected
                driveStatusText.innerHTML = '<strong>Storage Status:</strong> <span style="color:var(--accent-ok,#34d399);">Connected</span>';
                authDriveConnectBtn.style.display = 'none';
                authDriveDisconnectBtn.style.display = 'inline-block';
                driveSettingsUI.style.display = 'block';
                
                // Fetch email
                const email = await bulkygenGoogleAuth.getUserEmail(token);
                if (email) {
                    driveUserEmail.textContent = email;
                    driveEmailText.style.display = 'block';
                }
            } else {
                // Disconnected
                driveStatusText.innerHTML = '<strong>Storage Status:</strong> Disconnected';
                driveEmailText.style.display = 'none';
                authDriveConnectBtn.style.display = 'inline-block';
                authDriveDisconnectBtn.style.display = 'none';
                driveSettingsUI.style.display = 'none';
            }
        } catch (e) {
            driveStatusText.innerHTML = `<strong>Storage Status:</strong> <span style="color:var(--accent-err,#f87171);">Error (${e.message})</span>`;
            authDriveConnectBtn.style.display = 'inline-block';
            authDriveDisconnectBtn.style.display = 'none';
            driveSettingsUI.style.display = 'none';
            driveEmailText.style.display = 'none';
        }
    }

    // Connect button click handler
    authDriveConnectBtn?.addEventListener('click', async () => {
        authDriveConnectBtn.disabled = true;
        authDriveConnectBtn.textContent = '⏳ Connecting...';
        await updateDriveAuthState(true);
        authDriveConnectBtn.disabled = false;
        authDriveConnectBtn.textContent = '🔗 Connect Google Drive';
    });

    // Disconnect button click handler
    authDriveDisconnectBtn?.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to disconnect Google Drive?')) return;
        authDriveDisconnectBtn.disabled = true;
        authDriveDisconnectBtn.textContent = '⏳ Disconnecting...';
        await bulkygenGoogleAuth.logout();
        
        // Also untoggle the "Enable Google Drive" checkbox if it was checked
        const enabledCheckbox = document.getElementById('driveEnabled');
        if (enabledCheckbox) enabledCheckbox.checked = false;
        updateDriveFieldsVisibility(); // from main visibility logic

        await updateDriveAuthState(false);
        authDriveDisconnectBtn.disabled = false;
        authDriveDisconnectBtn.textContent = 'Disconnect';
        showSaveStatus('✓ Disconnected', 'ok');
    });

    // Initial check on load
    updateDriveAuthState(false);

    // ── Copy Logs ─────────────────────────────────────────────────────────
    document.getElementById('copyLogsBtn')?.addEventListener('click', async () => {
        const result = document.getElementById('logsActionResult');
        try {
            // Ask background service worker for the log export via messaging
            const text = await new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'exportLogs' }, (resp) => {
                    resolve((resp && resp.text) || '(no logs)');
                });
            });
            await navigator.clipboard.writeText(text);
            if (result) { result.textContent = '✓ Copied to clipboard'; result.className = 'test-result pass'; }
        } catch (e) {
            // Fallback: if messaging fails, try local logger directly
            try {
                const text = globalThis.bulkygenLogger?.exportText?.() || '(no logs in this page context)';
                await navigator.clipboard.writeText(text);
                if (result) { result.textContent = '✓ Copied (page context)'; result.className = 'test-result pass'; }
            } catch (e2) {
                if (result) { result.textContent = '✗ ' + e2.message; result.className = 'test-result fail'; }
            }
        }
        if (result) setTimeout(() => { result.textContent = ''; }, 4000);
    });

    // ── Clear Logs ────────────────────────────────────────────────────────
    document.getElementById('clearLogsBtn')?.addEventListener('click', async () => {
        const result = document.getElementById('logsActionResult');
        try {
            // Clear via storage — both page & service worker will drop the buffer on next restore
            await chrome.storage.local.remove('bulkygen_logs');
            if (result) { result.textContent = '✓ Logs cleared'; result.className = 'test-result pass'; }
        } catch (e) {
            if (result) { result.textContent = '✗ ' + e.message; result.className = 'test-result fail'; }
        }
        if (result) setTimeout(() => { result.textContent = ''; }, 4000);
    });

    // ── Live log level application ─────────────────────────────────────────
    // Apply immediately so the background service worker respects the new level
    // without needing a full extension reload.
    function applyLogLevel() {
        const level = document.getElementById('logLevel')?.value || 'info';
        const debug = document.getElementById('debugMode')?.checked || false;
        const effective = debug ? 'verbose' : level;
        globalThis.bulkygenLogger?.setLevel?.(effective);
        chrome.runtime.sendMessage({ action: 'applyLogLevel', level: effective }).catch(() => {});
    }
    document.getElementById('logLevel')?.addEventListener('change', applyLogLevel);
    document.getElementById('debugMode')?.addEventListener('change', applyLogLevel);

    // ── Status flash helper ───────────────────────────────────────────────
    function showSaveStatus(msg, type) {
        const el = document.getElementById('saveStatus');
        if (!el) return;
        el.textContent = msg;
        el.className = 'save-status show ' + type;
        setTimeout(() => { el.classList.remove('show'); }, 3000);
    }

})();
