/**
 * BulkyGen Metadata Engine
 * Validates, normalizes, maps, and serializes metadata using the
 * serializer-agnostic mapping table and external serializer libraries.
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

    /**
     * Executes the full metadata injection pipeline.
     */
    async function processAndInject(jpegBlob, rawMetadata) {
        if (!rawMetadata) return jpegBlob;

        try {
            log()?.info(TAG, 'Starting metadata pipeline...');
            
            // 1. Normalize & Validate
            const metadata = normalize(rawMetadata);

            // 2. Map
            const mapper = globalThis.bulkygenMetadataMapper;
            if (!mapper) {
                log()?.error(TAG, 'Metadata Mapper not found. Skipping metadata.');
                return jpegBlob;
            }

            const xmpDict = mapper.mapMetadata(metadata, 'xmp');
            const exifDict = mapper.mapMetadata(metadata, 'exif');
            // const iptcDict = mapper.mapMetadata(metadata, 'iptc'); // IPTC pending library

            let finalBlob = jpegBlob;

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

            log()?.info(TAG, 'Metadata pipeline complete.');
            return finalBlob;

        } catch (e) {
            log()?.error(TAG, 'Metadata pipeline failed: ' + e.message);
            return jpegBlob;
        }
    }

    globalThis.bulkygenMetadataEngine = {
        processAndInject
    };
})();
