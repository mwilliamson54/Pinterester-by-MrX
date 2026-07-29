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
                        exifObj[ifd][tagId] = stringToUcs2(value);
                    } else if (Array.isArray(value) && tagStr.startsWith('XP')) {
                        exifObj[ifd][tagId] = stringToUcs2(value.join('; '));
                    } else if (Array.isArray(value)) {
                        exifObj[ifd][tagId] = value.join(', ');
                    } else {
                        exifObj[ifd][tagId] = String(value);
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
            const bytes = new Uint8Array(exifBinaryString.length);
            for (let i = 0; i < exifBinaryString.length; i++) {
                bytes[i] = exifBinaryString.charCodeAt(i) & 0xFF;
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