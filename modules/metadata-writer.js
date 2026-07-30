/**
 * BulkyGen Metadata Writer Module (Wave 3 — Phase 11)
 * Embeds JPEG metadata (EXIF/IPTC/XMP) using pure JavaScript.
 * No native executables, no ExifTool, fully in-browser compatible.
 *
 * In Wave 1 this is a stub that returns the blob unchanged.
 * Full implementation in Wave 3 using a minimal custom EXIF writer
 * or the piexifjs library (included as a web-accessible resource).
 *
 * Supports fields from Supabase: Title, Description, Keywords, Author,
 * Copyright, Creator, Website URL, Creation Date, Image ID, Prompt ID.
 */
/**
 * BulkyGen Metadata Writer Module (Wave 3)
 * Acts as the public API boundary for the metadata pipeline.
 * Delegates actual validation, mapping, and serialization to the Metadata Engine.
 */
(function () {
    'use strict';

    const TAG = 'MetadataWriter';
    const log = () => globalThis.bulkygenLogger;

    /**
     * Public API to embed metadata into an image blob (JPEG, PNG, or WebP).
     * @param {Blob} imageBlob — input image blob
     * @param {Object} rawMetadata — structured metadata JSON from Supabase
     * @param {Object} [opts] — { width, height } (needed for WebP, to synthesize its VP8X chunk)
     * @returns {Promise<{blob: Blob, embedded: boolean, reason: string|null}>}
     *   `embedded` is only true if metadata was ACTUALLY written -- callers
     *   must use it (not "did this throw?") to decide whether to report
     *   metadata_written: true, since every layer below this one fails soft
     *   and hands back the original blob rather than throwing.
     */
    async function embedMetadata(imageBlob, rawMetadata, opts) {
        if (!globalThis.bulkygenMetadataEngine) {
            log()?.error(TAG, 'Metadata engine not loaded. Returning blob unchanged.');
            return { blob: imageBlob, embedded: false, reason: 'metadata engine not loaded' };
        }

        try {
            return await globalThis.bulkygenMetadataEngine.processAndInject(imageBlob, rawMetadata, opts);
        } catch (e) {
            log()?.error(TAG, 'Failed to embed metadata: ' + e.message);
            return { blob: imageBlob, embedded: false, reason: e.message };
        }
    }

    /**
     * Check whether metadata embedding is supported in this context.
     * @returns {boolean}
     */
    function isSupported() {
        return !!globalThis.bulkygenMetadataEngine;
    }

    globalThis.bulkygenMetadataWriter = {
        embedMetadata,
        isSupported
    };
})();