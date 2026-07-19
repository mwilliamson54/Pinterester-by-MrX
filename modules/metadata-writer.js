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
     * Public API to embed metadata into a JPEG blob.
     * @param {Blob} jpegBlob — input JPEG blob
     * @param {Object} rawMetadata — structured metadata JSON from Supabase
     * @returns {Promise<Blob>} JPEG blob with embedded metadata
     */
    async function embedMetadata(jpegBlob, rawMetadata) {
        if (!globalThis.bulkygenMetadataEngine) {
            log()?.error(TAG, 'Metadata engine not loaded. Returning blob unchanged.');
            return jpegBlob;
        }

        try {
            return await globalThis.bulkygenMetadataEngine.processAndInject(jpegBlob, rawMetadata);
        } catch (e) {
            log()?.error(TAG, 'Failed to embed metadata: ' + e.message);
            return jpegBlob;
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
