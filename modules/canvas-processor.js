/**
 * BulkyGen Canvas Processor Module (Wave 2 — Phases 7, 8, 9, 10)
 * Handles ALL image manipulation via OffscreenDocument + OffscreenCanvas:
 *   - Metadata stripping (re-encode through canvas)
 *   - JPEG compression at configurable quality
 *   - Watermark rendering (text, logo, or both)
 *
 * In Wave 1 this is a valid stub that passes images through unchanged.
 * The offscreen document bridge is wired in Wave 2.
 */
(function () {
    'use strict';

    const TAG = 'CanvasProcessor';
    const log = () => globalThis.bulkygenLogger;

    let offscreenCreating = null;

    async function ensureOffscreenDocument() {
        if (!globalThis.chrome?.offscreen) {
            throw new Error('chrome.offscreen API not available');
        }

        const offscreenUrl = chrome.runtime.getURL('offscreen.html');

        try {
            if (chrome.runtime.getContexts) {
                const contexts = await chrome.runtime.getContexts({
                    contextTypes: ['OFFSCREEN_DOCUMENT'],
                    documentUrls: [offscreenUrl]
                });
                if (contexts && contexts.length > 0) {
                    return;
                }
            }
        } catch (e) {
            // ignore context retrieval errors, proceed to creation check
        }

        if (offscreenCreating) {
            await offscreenCreating;
            return;
        }

        offscreenCreating = chrome.offscreen.createDocument({
            url: offscreenUrl,
            reasons: ['DOM_PARSER', 'BLOBS'],
            justification: 'Strips metadata, compresses JPEG, and embeds watermark.'
        }).catch((err) => {
            if (err.message && err.message.includes('Only a single offscreen document may be created')) {
                return; // already created
            }
            throw err;
        });

        try {
            await offscreenCreating;
        } finally {
            offscreenCreating = null;
        }
    }

    /**
     * Process an image data URL:
      *   1. Strip EXIF/metadata by re-drawing through OffscreenCanvas
      *   2. Apply watermark (if watermarkOptions.enabled === true)
      *   3. Export as JPEG at the configured quality
     *
     * Routes processing through the chrome offscreen document to access
     * DOM canvas APIs from background context.
     *
     * @param {string} inputDataUrl — data:image/... base64 string
     * @param {Object} [watermarkOptions] — from Supabase record
     * @param {Object} [cfg] — { jpegQuality: 0.90 }
     * @returns {Promise<{ dataUrl: string, width: number, height: number, mimeType: string }>}
     */
    async function processImage(inputDataUrl, watermarkOptions, cfg) {
        if (inputDataUrl && (inputDataUrl.startsWith('data:video/') || inputDataUrl.includes('video/mp4') || inputDataUrl.includes('video/webm'))) {
            log()?.info(TAG, 'Input is a video — passing through without canvas processing');
            const mime = inputDataUrl.match(/^data:([^;]+);/)?.[1] || 'video/mp4';
            return {
                dataUrl: inputDataUrl,
                width: 0,
                height: 0,
                mimeType: mime
            };
        }

        log()?.info(TAG, 'processImage() — Routing request to offscreen document...');

        if (!isOffscreenSupported()) {
            log()?.warn(TAG, 'Offscreen API not supported — passing image through unchanged');
            return {
                dataUrl: inputDataUrl,
                width: 0,
                height: 0,
                mimeType: 'image/jpeg'
            };
        }

        try {
            await ensureOffscreenDocument();

            const response = await chrome.runtime.sendMessage({
                action: 'offscreenProcessImage',
                dataUrl: inputDataUrl,
                watermark: watermarkOptions,
                jpegQuality: cfg?.jpegQuality || 0.90
            });

            if (!response || response.success === false) {
                throw new Error(response?.error || 'Failed to process image in offscreen canvas');
            }

            log()?.info(TAG, `Successfully processed image via offscreen: ${response.width}x${response.height}, quality=${cfg?.jpegQuality}`);
            return {
                dataUrl: response.dataUrl,
                width: response.width,
                height: response.height,
                mimeType: response.mimeType
            };
        } catch (err) {
            log()?.error(TAG, `Offscreen canvas processing failed: ${err.message}. Passing through original.`);
            return {
                dataUrl: inputDataUrl,
                width: 0,
                height: 0,
                mimeType: 'image/jpeg'
            };
        }
    }

    /**
     * Check whether the OffscreenDocument API is available.
     * @returns {boolean}
     */
    function isOffscreenSupported() {
        return !!(globalThis.chrome?.offscreen);
    }

    globalThis.bulkygenCanvasProcessor = {
        processImage,
        isOffscreenSupported
    };
})();
