/**
 * BulkyGen EXIF Serializer
 * Uses piexifjs to serialize mapped EXIF dictionary into JPEG.
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
     * Embeds EXIF data using piexif.
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
                
                // Get numeric tag ID from piexif
                const dictName = ifd === '0th' ? 'ImageIFD' : ifd;
                const tagId = piexif.TagValues[dictName]?.[tagStr] || piexif[dictName]?.[tagStr];
                
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

        try {
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
        embed
    };
})();
