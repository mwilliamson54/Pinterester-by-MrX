/**
 * BulkyGen Google Auth Module
 * Manages modern OAuth 2.0 flow using chrome.identity for Manifest V3.
 */
(function () {
    'use strict';

    const TAG = 'GoogleAuth';
    const log = () => globalThis.bulkygenLogger;

    /**
     * Get a fresh OAuth access token.
     * @param {boolean} interactive - Whether to prompt the user if no cached token exists.
     * @returns {Promise<string|null>} - The access token or null if auth fails/user cancels.
     */
    async function getAccessToken(interactive = false) {
        return new Promise((resolve, reject) => {
            if (!globalThis.chrome?.identity?.getAuthToken) {
                const msg = 'chrome.identity API is not available.';
                log()?.error(TAG, msg);
                reject(new Error(msg));
                return;
            }
            chrome.identity.getAuthToken({ interactive }, (token) => {
                if (chrome.runtime.lastError) {
                    const msg = chrome.runtime.lastError.message;
                    // If user closed the popup or denied, it's not a hard error to log as an error, just info
                    if (msg.includes('user did not approve') || msg.includes('user cancelled') || msg.includes('User interaction required')) {
                        log()?.info(TAG, `Google Auth cancelled or required: ${msg}`);
                        resolve(null); // Just return null for normal flows
                    } else {
                        log()?.warn(TAG, `Google Auth failed: ${msg}`);
                        reject(new Error(msg));
                    }
                } else if (!token) {
                    resolve(null);
                } else {
                    resolve(token);
                }
            });
        });
    }

    /**
     * Remove an invalid/expired token from the chrome.identity cache.
     * @param {string} token
     * @returns {Promise<void>}
     */
    async function removeCachedToken(token) {
        return new Promise((resolve) => {
            if (!globalThis.chrome?.identity?.removeCachedAuthToken || !token) {
                resolve();
                return;
            }
            chrome.identity.removeCachedAuthToken({ token }, () => {
                log()?.info(TAG, 'Cleared invalid OAuth token from cache.');
                resolve();
            });
        });
    }

    /**
     * Fetch the connected user's email address using the userinfo endpoint.
     * @param {string} token
     * @returns {Promise<string|null>}
     */
    async function getUserEmail(token) {
        if (!token) return null;
        try {
            const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo?fields=email', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.status === 401) {
                await removeCachedToken(token);
                return null;
            }
            if (res.ok) {
                const data = await res.json();
                return data.email || null;
            }
            return null;
        } catch (err) {
            log()?.error(TAG, `getUserEmail error: ${err.message}`);
            return null;
        }
    }

    /**
     * Revoke the token on Google's servers.
     * @param {string} token
     * @returns {Promise<void>}
     */
    async function revokeToken(token) {
        if (!token) return;
        try {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            log()?.info(TAG, 'OAuth token revoked on server.');
        } catch (err) {
            log()?.warn(TAG, `Failed to revoke token on server: ${err.message}`);
        }
    }

    /**
     * Full logout process: revoke token, clear cache, and disable Drive in settings.
     * @returns {Promise<void>}
     */
    async function logout() {
        try {
            const token = await getAccessToken(false);
            if (token) {
                await revokeToken(token);
                await removeCachedToken(token);
            }
            
            // Also turn off the setting automatically if logged out
            if (globalThis.bulkygenSettings) {
                await globalThis.bulkygenSettings.set({ driveEnabled: false });
            }
            log()?.info(TAG, 'Successfully logged out of Google Drive.');
        } catch (err) {
            log()?.error(TAG, `Logout error: ${err.message}`);
            throw err;
        }
    }

    globalThis.bulkygenGoogleAuth = {
        getAccessToken,
        removeCachedToken,
        getUserEmail,
        revokeToken,
        logout
    };
})();
