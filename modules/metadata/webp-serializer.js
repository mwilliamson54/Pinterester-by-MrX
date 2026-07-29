/**
 * BulkyGen WebP Serializer
 * Embeds EXIF + XMP metadata into a WebP file using WebP's own RIFF
 * container chunks -- a small pure-JS "webpmux"-equivalent. No WASM, no
 * re-encoding of the actual VP8/VP8L image data (it's copied byte-for-byte).
 *
 * A plain single-frame WebP from canvas.convertToBlob() has no VP8X
 * "extended" chunk. That chunk (and its EXIF/XMP flag bits) has to be
 * synthesized before EXIF/XMP chunks can be added, per the WebP container spec.
 */
(function () {
    'use strict';

    // VP8X flag bits (per the WebP container spec / libwebp's format_constants.h)
    const FLAG_ANIMATION = 1 << 1;
    const FLAG_XMP = 1 << 2;
    const FLAG_EXIF = 1 << 3;
    const FLAG_ALPHA = 1 << 4;
    const FLAG_ICCP = 1 << 5;

    function u32le(n) {
        return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);
    }
    function concatBytes(arrays) {
        const len = arrays.reduce((s, a) => s + a.length, 0);
        const out = new Uint8Array(len);
        let off = 0;
        for (const a of arrays) { out.set(a, off); off += a.length; }
        return out;
    }
    function fourCC(bytes, offset) {
        return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    }

    // Parse a RIFF/WEBP file into its top-level chunks (type + raw data, no
    // padding byte included in `data`).
    function parseChunks(bytes) {
        if (fourCC(bytes, 0) !== 'RIFF' || fourCC(bytes, 8) !== 'WEBP') {
            throw new Error('Not a valid WebP (missing RIFF/WEBP header)');
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const chunks = [];
        let offset = 12;
        while (offset + 8 <= bytes.length) {
            const type = fourCC(bytes, offset);
            const size = view.getUint32(offset + 4, true);
            const dataStart = offset + 8;
            const data = bytes.subarray(dataStart, dataStart + size);
            chunks.push({ type, data });
            offset = dataStart + size + (size % 2); // chunks are padded to an even length
        }
        return chunks;
    }

    // Wrap raw chunk data with its FourCC header + little-endian size + a
    // padding byte if the data length is odd (required by the RIFF spec).
    function buildChunk(type, data) {
        const typeBytes = new TextEncoder().encode(type.padEnd(4).slice(0, 4));
        const pad = (data.length % 2) ? new Uint8Array([0]) : new Uint8Array(0);
        return concatBytes([typeBytes, u32le(data.length), data, pad]);
    }

    /**
     * @param {Blob} webpBlob
     * @param {number} width  - image width (needed to synthesize VP8X if the source doesn't already have one)
     * @param {number} height - image height
     * @param {string} [xmpXml] - XMP packet string (same one used for JPEG/PNG)
     * @param {Uint8Array} [exifBytes] - raw TIFF/EXIF bytes (same ones used for JPEG/PNG)
     * @returns {Promise<Blob>}
     */
    async function embed(webpBlob, width, height, xmpXml, exifBytes) {
        const hasXmp = !!xmpXml;
        const hasExif = !!(exifBytes && exifBytes.length);
        if (!hasXmp && !hasExif) return webpBlob;
        if (!width || !height) return webpBlob; // can't safely synthesize VP8X without real dimensions

        const bytes = new Uint8Array(await webpBlob.arrayBuffer());
        const chunks = parseChunks(bytes);

        const existingVp8x = chunks.find(c => c.type === 'VP8X');
        const hasAlphaChunk = chunks.some(c => c.type === 'ALPH');
        const otherChunks = chunks.filter(c => c.type !== 'VP8X');

        // Start from any flags the source already set (preserves ICC/alpha/
        // animation if the browser already produced an extended-format file),
        // then OR in EXIF/XMP.
        let flags = existingVp8x ? existingVp8x.data[0] : 0;
        if (hasAlphaChunk) flags |= FLAG_ALPHA;
        if (hasExif) flags |= FLAG_EXIF;
        if (hasXmp) flags |= FLAG_XMP;

        const vp8xData = new Uint8Array(10); // 1 flags + 3 reserved + 3 width-1 + 3 height-1
        vp8xData[0] = flags;
        const w = Math.max(1, Math.round(width)) - 1;
        const h = Math.max(1, Math.round(height)) - 1;
        vp8xData[4] = w & 0xFF; vp8xData[5] = (w >>> 8) & 0xFF; vp8xData[6] = (w >>> 16) & 0xFF;
        vp8xData[7] = h & 0xFF; vp8xData[8] = (h >>> 8) & 0xFF; vp8xData[9] = (h >>> 16) & 0xFF;

        const parts = [buildChunk('VP8X', vp8xData)];

        // ICCP must immediately follow VP8X per spec, if present.
        const iccp = otherChunks.find(c => c.type === 'ICCP');
        if (iccp) parts.push(buildChunk('ICCP', iccp.data));

        for (const c of otherChunks) {
            if (c.type === 'ICCP') continue; // already placed right after VP8X
            parts.push(buildChunk(c.type, c.data));
        }

        if (hasExif) parts.push(buildChunk('EXIF', exifBytes));
        if (hasXmp) parts.push(buildChunk('XMP ', new TextEncoder().encode(xmpXml)));

        const payload = concatBytes(parts);
        const riffSize = 4 + payload.length; // "WEBP" + all chunks that follow
        const out = concatBytes([
            new TextEncoder().encode('RIFF'),
            u32le(riffSize),
            new TextEncoder().encode('WEBP'),
            payload
        ]);

        return new Blob([out], { type: 'image/webp' });
    }

    globalThis.bulkygenWebpSerializer = { embed };
})();