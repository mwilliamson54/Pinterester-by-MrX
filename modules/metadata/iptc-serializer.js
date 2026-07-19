/**
 * BulkyGen IPTC Serializer
 * Basic native serialization of IPTC fields into APP13 segment.
 */
(function() {
    'use strict';

    // IPTC datasets (Record 2)
    const IPTC_TAGS = {
        'ObjectName': 5,
        'Urgency': 10,
        'Category': 15,
        'SupplementalCategories': 20,
        'Keywords': 25,
        'Instructions': 40,
        'DateCreated': 55,
        'Byline': 80,
        'BylineTitle': 85,
        'City': 90,
        'Province': 95,
        'CountryCode': 100,
        'Country': 101,
        'Headline': 105,
        'Credit': 110,
        'Source': 115,
        'Copyright Notice': 116,
        'Caption': 120,
        'Writer': 122
    };

    /**
     * Embed IPTC data into JPEG blob
     */
    async function embed(jpegBlob, mappedIptc) {
        if (!mappedIptc || Object.keys(mappedIptc).length === 0) return jpegBlob;

        const encoder = new TextEncoder();
        const datasets = [];

        for (const [key, value] of Object.entries(mappedIptc)) {
            const tag = IPTC_TAGS[key];
            if (!tag) continue;

            const values = Array.isArray(value) ? value : [value];
            for (const val of values) {
                const strBytes = encoder.encode(String(val));
                // Max length is 32767
                if (strBytes.length > 32000) continue; 
                
                // 1C 02 <tag> <lenHigh> <lenLow> <data>
                datasets.push(0x1C, 0x02, tag, (strBytes.length >> 8) & 0xFF, strBytes.length & 0xFF, ...strBytes);
            }
        }

        if (datasets.length === 0) return jpegBlob;

        const ps3Header = encoder.encode('Photoshop 3.0\0');
        const bimHeader = encoder.encode('8BIM');
        
        const resourceBlock = [
            ...ps3Header,
            ...bimHeader,
            0x04, 0x04, // ID
            0x00, 0x00, // Name (empty pascal string)
            (datasets.length >> 24) & 0xFF, (datasets.length >> 16) & 0xFF, (datasets.length >> 8) & 0xFF, datasets.length & 0xFF,
            ...datasets
        ];
        
        if (resourceBlock.length % 2 !== 0) resourceBlock.push(0x00);

        const markerLen = resourceBlock.length + 2;
        const segment = [0xFF, 0xED, (markerLen >> 8) & 0xFF, markerLen & 0xFF, ...resourceBlock];

        const arrBuffer = await jpegBlob.arrayBuffer();
        const jpegBytes = new Uint8Array(arrBuffer);

        let offset = 2;
        while (offset < jpegBytes.length) {
            if (jpegBytes[offset] === 0xFF) {
                const marker = jpegBytes[offset + 1];
                if (marker === 0xE0 || marker === 0xE1) {
                    const len = (jpegBytes[offset + 2] << 8) | jpegBytes[offset + 3];
                    offset += 2 + len;
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        const before = jpegBytes.subarray(0, offset);
        const after = jpegBytes.subarray(offset);

        const outputBytes = new Uint8Array(before.length + segment.length + after.length);
        outputBytes.set(before, 0);
        outputBytes.set(segment, before.length);
        outputBytes.set(after, before.length + segment.length);

        return new Blob([outputBytes], { type: 'image/jpeg' });
    }

    globalThis.bulkygenIptcSerializer = { embed };
})();
