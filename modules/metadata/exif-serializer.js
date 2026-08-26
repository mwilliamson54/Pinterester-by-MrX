/**
 * BulkyGen EXIF Serializer
 * Uses piexifjs to serialize a mapped EXIF dictionary, either wrapped into a
 * JPEG's APP1 marker (embed) or as the raw TIFF/EXIF byte blob that PNG's
 * "eXIf" chunk and WebP's "EXIF" chunk both expect directly (buildRawExifBytes).
 */
(function() {
    'use strict';

    /**
     * Helper to encode strings to UCS2 byte array for Windows XP tags
     */
    function stringToUcs2(str) {
        const arr = [];
        for (let i = 0; i < str.length; i++) {
            arr.push(str.charCodeAt(i) & 0xFF);
            arr.push(str.charCodeAt(i) >> 8);
        }
        arr.push(0, 0); // null terminator
        return arr;
    }

    /**
     * FIX (see root-cause notes below): TIFF's "Ascii" tag type -- used for
     * ImageDescription, Artist, Copyright, UserComment, DateTime, and every
     * other non-"XP" string tag -- can only safely hold single-byte Latin-1
     * characters (character codes 0-255). piexifjs does not check this: it
     * just hands whatever JS string it's given straight through as if every
     * character were already one byte.
     *
     * The moment a value contains a character outside that range -- most
     * commonly a "smart"/typographic character like an em dash "—", a curly
     * quote, or an ellipsis "…", all very common in AI-written captions --
     * everything piexif writes into the file from that point on silently
     * desyncs. The file still opens far enough for basic tools to read the
     * first few tags, but every real image viewer, which has to walk the
     * whole marker chain to reach the actual picture, hits that broken
     * region and fails outright. No exception is thrown anywhere in this
     * pipeline when that happens, so it fails completely silently.
     *
     * This replaces the common typographic characters with plain-ASCII
     * equivalents, and strips anything else outside the safe 0-255 range,
     * so a value can never reach piexif's Ascii serializer with a character
     * it can't represent. Characters already in the Latin-1 range (e.g. the
     * "©" copyright symbol) are untouched -- they were never the problem.
     */
    function sanitizeForAsciiTag(str) {
        if (typeof str !== 'string') return str;
        const replacements = {
            '\u2014': '-',   // em dash —
            '\u2013': '-',   // en dash –
            '\u2018': "'",   // left single quote '
            '\u2019': "'",   // right single quote '
            '\u201C': '"',   // left double quote "
            '\u201D': '"',   // right double quote "
            '\u2026': '...', // ellipsis …
            '\u00A0': ' '    // non-breaking space
        };
        const withCommonSwaps = str.replace(
            /[\u2014\u2013\u2018\u2019\u201C\u201D\u2026\u00A0]/g,
            ch => replacements[ch]
        );
        // Anything still outside 0-255 (emoji, CJK, Cyrillic, etc.) is
        // dropped rather than silently corrupting the rest of the file.
        return withCommonSwaps.replace(/[^\x00-\xFF]/g, '');
    }

    // Build the piexif exifObj ({ "0th": {...}, "Exif": {...}, ... }) from our
    // mapped dot-notation dictionary (e.g. { "0th.ImageDescription": "..." }).
    function buildExifObj(mappedExif) {
        const exifObj = {
            "0th": {},
            "Exif": {},
            "GPS": {},
            "1st": {},
            "Interop": {}
        };

        for (const [key, value] of Object.entries(mappedExif)) {
            const parts = key.split('.');
            if (parts.length === 2) {
                const ifd = parts[0];
                const tagStr = parts[1];

                // Get numeric tag ID from piexif. piexif exposes its tag
                // dictionaries as ImageIFD / ExifIFD / GPSIFD / InteropIFD —
                // not under the raw IFD section names used in mappedExif keys.
                const dictNameMap = {
                    '0th': 'ImageIFD',
                    '1st': 'ImageIFD',
                    'Exif': 'ExifIFD',
                    'GPS': 'GPSIFD',
                    'Interop': 'InteropIFD'
                };
                const dictName = dictNameMap[ifd] || ifd;
                const tagId = piexif[dictName]?.[tagStr];

                if (tagId !== undefined) {
                    if (tagStr.startsWith('XP') && typeof value === 'string') {
                        // XP* tags are UCS2/UTF-16LE under the hood, so they
                        // can safely carry any Unicode character as-is.
                        exifObj[ifd][tagId] = stringToUcs2(value);
                    } else if (Array.isArray(value) && tagStr.startsWith('XP')) {
                        exifObj[ifd][tagId] = stringToUcs2(value.join('; '));
                    } else if (Array.isArray(value)) {
                        exifObj[ifd][tagId] = sanitizeForAsciiTag(value.join(', '));
                    } else {
                        exifObj[ifd][tagId] = sanitizeForAsciiTag(String(value));
                    }
                }
            }
        }
        return exifObj;
    }

    /**
     * Build the raw TIFF/EXIF byte blob (no JPEG APP1 wrapper) — the same
     * format PNG's "eXIf" chunk and WebP's "EXIF" chunk both expect directly.
     * @param {Object} mappedExif
     * @returns {Uint8Array|null}
     */
    function buildRawExifBytes(mappedExif) {
        if (!globalThis.piexif || !mappedExif || Object.keys(mappedExif).length === 0) return null;
        try {
            const exifObj = buildExifObj(mappedExif);
            const exifBinaryString = piexif.dump(exifObj); // raw bytes, as a binary string
            // piexif.dump() always prepends the 6-byte JPEG APP1 header
            // "Exif\x00\x00" to its output.  For JPEG that's correct (the
            // APP1 marker expects it), but WebP's RIFF "EXIF" chunk and
            // PNG's "eXIf" chunk both expect raw TIFF data starting with
            // the byte-order mark (II or MM), NOT the APP1 wrapper.  Strip
            // the prefix when present so the downstream container
            // serializers receive clean TIFF bytes.
            const EXIF_HEADER = 'Exif\x00\x00';
            let startOffset = 0;
            if (exifBinaryString.length > 6 &&
                exifBinaryString.substring(0, 6) === EXIF_HEADER) {
                startOffset = 6;
            }
            const length = exifBinaryString.length - startOffset;
            const bytes = new Uint8Array(length);
            for (let i = 0; i < length; i++) {
                bytes[i] = exifBinaryString.charCodeAt(i + startOffset) & 0xFF;
            }
            return bytes;
        } catch (e) {
            console.error('EXIF byte build error:', e);
            return null;
        }
    }

    /**
     * Embeds EXIF data into a JPEG blob using piexif (APP1 marker).
     */
    async function embed(jpegBlob, mappedExif) {
        if (!globalThis.piexif || !mappedExif || Object.keys(mappedExif).length === 0) {
            return jpegBlob;
        }

        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(jpegBlob);
        });

        try {
            const exifObj = buildExifObj(mappedExif);
            const exifBytes = piexif.dump(exifObj);
            const newJpegDataUrl = piexif.insert(exifBytes, dataUrl);

            // convert back to blob
            const parts = newJpegDataUrl.split(',');
            const mime = parts[0].match(/:(.*?);/)[1];
            const bstr = atob(parts[1]);
            let n = bstr.length;
            const u8arr = new Uint8Array(n);
            while (n--) {
                u8arr[n] = bstr.charCodeAt(n);
            }
            return new Blob([u8arr], { type: mime });
        } catch (e) {
            console.error('EXIF embed error:', e);
            return jpegBlob;
        }
    }

    globalThis.bulkygenExifSerializer = {
        embed,
        buildRawExifBytes
    };
})();