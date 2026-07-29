/**
 * BulkyGen PNG Serializer
 * Embeds metadata into PNG images using PNG's own chunk mechanism -- no
 * re-encoding of the pixel data (IDAT), just splicing extra chunks in:
 *
 *   - tEXt chunks for the classic simple keyword=value fields (Title,
 *     Description, Author, Copyright, Software) using PNG's own predefined
 *     keyword list, so any PNG-aware tool can read them without needing to
 *     understand XMP.
 *   - An iTXt chunk keyed "XML:com.adobe.xmp" carrying a full XMP packet
 *     (the same XMP model used for JPEG/WebP), for richer structured
 *     metadata and tools that read XMP (Lightroom, Photoshop, ExifTool...).
 *   - An "eXIf" chunk carrying the same raw EXIF/TIFF bytes used for JPEG
 *     and WebP, for tools that specifically read PNG's EXIF chunk.
 */
(function () {
    'use strict';

    const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    // ── CRC-32 (every PNG chunk carries one, over its type+data bytes) ──────
    let crcTable = null;
    function makeCrcTable() {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c >>> 0;
        }
        return table;
    }
    function crc32(bytes) {
        if (!crcTable) crcTable = makeCrcTable();
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) {
            c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function u32be(n) {
        return new Uint8Array([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]);
    }

    function concatBytes(arrays) {
        const len = arrays.reduce((s, a) => s + a.length, 0);
        const out = new Uint8Array(len);
        let off = 0;
        for (const a of arrays) { out.set(a, off); off += a.length; }
        return out;
    }

    function encodeLatin1(str) {
        const arr = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xFF;
        return arr;
    }

    // Build one complete chunk: length(4, BE) + type(4) + data + crc(4, BE)
    function buildChunk(type, data) {
        const typeBytes = new TextEncoder().encode(type);
        const body = concatBytes([typeBytes, data]);
        const crc = crc32(body);
        return concatBytes([u32be(data.length), body, u32be(crc)]);
    }

    // Classic Latin-1 keyword=value chunk. Only safe for Latin-1-range text.
    function buildTextChunk(keyword, text) {
        const data = concatBytes([encodeLatin1(keyword), new Uint8Array([0]), encodeLatin1(text)]);
        return buildChunk('tEXt', data);
    }

    // UTF-8 international text chunk -- used for anything that might contain
    // non-Latin-1 characters, and for the embedded XMP packet.
    function buildITxtChunk(keyword, text) {
        const data = concatBytes([
            encodeLatin1(keyword),         // keyword is still Latin-1 per spec
            new Uint8Array([0]),           // null separator
            new Uint8Array([0]),           // compression flag (0 = not compressed)
            new Uint8Array([0]),           // compression method (unused, flag=0)
            new Uint8Array([0]),           // language tag (empty) + null terminator
            new Uint8Array([0]),           // translated keyword (empty) + null terminator
            new TextEncoder().encode(text) // the actual UTF-8 text
        ]);
        return buildChunk('iTXt', data);
    }

    function buildExifChunk(exifBytes) {
        return buildChunk('eXIf', exifBytes);
    }

    // Split the file into: signature+IHDR (kept as-is) and everything after,
    // so new chunks can be spliced in right after IHDR without touching the
    // rest of the file (PLTE/IDAT/etc, and their pixel data, byte-for-byte).
    function splitAfterIHDR(bytes) {
        for (let i = 0; i < 8; i++) {
            if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('Not a valid PNG (bad signature)');
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const ihdrDataLen = view.getUint32(8, false);
        const ihdrChunkLen = 4 + 4 + ihdrDataLen + 4; // length + type + data + crc
        return {
            header: bytes.subarray(0, 8),
            ihdrChunk: bytes.subarray(8, 8 + ihdrChunkLen),
            rest: bytes.subarray(8 + ihdrChunkLen)
        };
    }

    /**
     * Embed metadata into a PNG blob.
     * @param {Blob} pngBlob
     * @param {Object} [textFields] - simple keyword/value pairs using PNG's
     *   predefined keywords, e.g. { Title, Description, Author, Copyright, Software }
     * @param {string} [xmpXml] - full XMP packet string (same one used for JPEG/WebP)
     * @param {Uint8Array} [exifBytes] - raw TIFF/EXIF bytes (same ones used for JPEG/WebP)
     * @returns {Promise<Blob>}
     */
    async function embed(pngBlob, textFields, xmpXml, exifBytes) {
        const buf = new Uint8Array(await pngBlob.arrayBuffer());
        const { header, ihdrChunk, rest } = splitAfterIHDR(buf);

        const newChunks = [];

        if (textFields) {
            for (const [key, rawValue] of Object.entries(textFields)) {
                if (rawValue === undefined || rawValue === null || rawValue === '') continue;
                const text = String(rawValue);
                const isLatin1 = /^[\x00-\xFF]*$/.test(text);
                newChunks.push(isLatin1 ? buildTextChunk(key, text) : buildITxtChunk(key, text));
            }
        }

        if (xmpXml) {
            newChunks.push(buildITxtChunk('XML:com.adobe.xmp', xmpXml));
        }

        if (exifBytes && exifBytes.length) {
            newChunks.push(buildExifChunk(exifBytes));
        }

        if (!newChunks.length) return pngBlob;

        const out = concatBytes([header, ihdrChunk, ...newChunks, rest]);
        return new Blob([out], { type: 'image/png' });
    }

    globalThis.bulkygenPngSerializer = { embed };
})();