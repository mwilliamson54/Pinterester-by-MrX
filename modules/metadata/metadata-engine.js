/**
 * BulkyGen Metadata Engine
 * Validates, normalizes, maps, and serializes metadata using the
 * serializer-agnostic mapping table and external serializer libraries.
 *
 * Same centralized xmpDict/exifDict feed all three output formats:
 *   - JPEG: APP1 EXIF marker + APP1 XMP marker (piexif / xmp-serializer)
 *   - PNG:  tEXt/iTXt chunks + eXIf chunk (png-serializer)
 *   - WebP: RIFF EXIF/XMP chunks (webp-serializer)
 */
(function() {
    'use strict';

    const log = () => globalThis.bulkygenLogger;
    const TAG = 'MetadataEngine';

    /**
     * Normalizes and validates the incoming metadata object.
     */
    function normalize(raw) {
        if (!raw || typeof raw !== 'object') return {};
        // Ensure schema_version is present
        raw.schema_version = raw.schema_version || 1;
        return raw;
    }

    function firstOf(v) {
        if (v === undefined || v === null) return undefined;
        return Array.isArray(v) ? v.join(', ') : v;
    }

    /**
     * PNG/WebP path: both use their own container-native chunk mechanisms
     * rather than JPEG's APP1 markers, but draw from the exact same
     * xmpDict/exifDict the JPEG path uses.
     */
    async function injectIntoContainerFormat(imageBlob, mimeType, xmpDict, exifDict, opts) {
        const hasXmp = Object.keys(xmpDict).length > 0;
        const hasExif = Object.keys(exifDict).length > 0;
        if (!hasXmp && !hasExif) return imageBlob;

        const xmpXml = (hasXmp && globalThis.bulkygenXmpSerializer)
            ? globalThis.bulkygenXmpSerializer.serialize(xmpDict)
            : null;

        const exifBytes = (hasExif && globalThis.bulkygenExifSerializer?.buildRawExifBytes)
            ? globalThis.bulkygenExifSerializer.buildRawExifBytes(exifDict)
            : null;

        if (mimeType === 'image/png') {
            if (!globalThis.bulkygenPngSerializer) {
                log()?.warn(TAG, 'PNG serializer not loaded — skipping metadata.');
                return imageBlob;
            }
            const textFields = {
                Title: firstOf(xmpDict['dc:title']),
                Description: firstOf(xmpDict['dc:description']),
                Author: firstOf(xmpDict['dc:creator']),
                Copyright: firstOf(xmpDict['dc:rights']),
                Software: firstOf(xmpDict['xmp:CreatorTool'])
            };
            log()?.info(TAG, 'Injecting PNG metadata chunks (tEXt/iTXt + eXIf)...');
            return await globalThis.bulkygenPngSerializer.embed(imageBlob, textFields, xmpXml, exifBytes);
        }

        if (mimeType === 'image/webp') {
            if (!globalThis.bulkygenWebpSerializer) {
                log()?.warn(TAG, 'WebP serializer not loaded — skipping metadata.');
                return imageBlob;
            }
            if (!opts?.width || !opts?.height) {
                log()?.warn(TAG, 'No image dimensions supplied — cannot safely embed WebP metadata, skipping.');
                return imageBlob;
            }
            log()?.info(TAG, 'Injecting WebP metadata chunks (EXIF/XMP)...');
            return await globalThis.bulkygenWebpSerializer.embed(imageBlob, opts.width, opts.height, xmpXml, exifBytes);
        }

        log()?.warn(TAG, `No metadata serializer available for ${mimeType} — skipping.`);
        return imageBlob;
    }

    /**
     * Executes the full metadata injection pipeline.
     * @param {Blob} imageBlob
     * @param {Object} rawMetadata
     * @param {Object} [opts] - { width, height } (only needed for WebP, to synthesize its VP8X chunk)
     */
    // Every serializer's embed() is contractually guaranteed to return the
    // SAME blob reference it was given when it didn't (or couldn't) change
    // anything, and to always construct a brand-new Blob when it actually
    // wrote something. That reference-identity is used below as the single
    // source of truth for whether metadata was really embedded -- instead of
    // treating "no exception was thrown" as success, which is what silently
    // caused metadata_written: true to be reported even when every serializer
    // had bailed out internally (missing library, unsupported format, no
    // dimensions for WebP, etc.) and handed the original blob straight back.
    async function processAndInject(imageBlob, rawMetadata, opts) {
        if (!rawMetadata) return { blob: imageBlob, embedded: false, reason: 'no metadata supplied' };

        try {
            log()?.info(TAG, 'Starting metadata pipeline...');

            // 1. Normalize & Validate
            const metadata = normalize(rawMetadata);

            // 2. Map
            const mapper = globalThis.bulkygenMetadataMapper;
            if (!mapper) {
                log()?.error(TAG, 'Metadata Mapper not found. Skipping metadata.');
                return { blob: imageBlob, embedded: false, reason: 'metadata mapper module not loaded' };
            }

            const xmpDict = mapper.mapMetadata(metadata, 'xmp');
            const exifDict = mapper.mapMetadata(metadata, 'exif');
            // const iptcDict = mapper.mapMetadata(metadata, 'iptc'); // IPTC pending library

            const mimeType = imageBlob.type || 'image/jpeg';

            // PNG/WebP use their own container-native chunk mechanisms.
            if (mimeType === 'image/png' || mimeType === 'image/webp') {
                const result = await injectIntoContainerFormat(imageBlob, mimeType, xmpDict, exifDict, opts);
                const embedded = result !== imageBlob;
                log()?.info(TAG, `Metadata pipeline complete (embedded=${embedded}).`);
                return {
                    blob: result,
                    embedded,
                    reason: embedded ? null : 'serializer returned the file unchanged (missing serializer module, unsupported dimensions, or nothing to embed)'
                };
            }

            // ── JPEG path (unchanged) ────────────────────────────────────────
            let finalBlob = imageBlob;

            // 3. Generate & Inject EXIF
            if (globalThis.bulkygenExifSerializer && Object.keys(exifDict).length > 0) {
                log()?.info(TAG, 'Injecting EXIF...');
                finalBlob = await globalThis.bulkygenExifSerializer.embed(finalBlob, exifDict);
            }

            // 4. Generate & Inject XMP
            if (globalThis.bulkygenXmpSerializer && Object.keys(xmpDict).length > 0) {
                log()?.info(TAG, 'Injecting XMP...');
                const xmpXml = globalThis.bulkygenXmpSerializer.serialize(xmpDict);
                finalBlob = await globalThis.bulkygenXmpSerializer.embed(finalBlob, xmpXml);
            }

            // 5. Verify (Readback)
            // Verification logic would go here: parse the finalBlob and ensure strings are present.
            // For now, we trust the pipeline since we rely on external proven libs and native XML.

            const embedded = finalBlob !== imageBlob;
            log()?.info(TAG, `Metadata pipeline complete (embedded=${embedded}).`);
            return {
                blob: finalBlob,
                embedded,
                reason: embedded ? null : 'no EXIF/XMP serializer produced a modified file (missing serializer module, empty metadata, or an internal embed failure)'
            };

        } catch (e) {
            log()?.error(TAG, 'Metadata pipeline failed: ' + e.message);
            return { blob: imageBlob, embedded: false, reason: e.message };
        }
    }

    globalThis.bulkygenMetadataEngine = {
        processAndInject
    };
})();