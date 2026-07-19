/**
 * BulkyGen Metadata Mapper
 * A unified table-driven mapping engine bridging our internal JSON
 * to EXIF, IPTC, and XMP standard fields.
 */
(function() {
    'use strict';

    // The mapping table
    // Maps internal dot-notation paths to target standard keys.
    const MAP = [
        // SEO
        {
            internal: 'seo.title',
            exif: ['0th.ImageDescription', '0th.XPTitle'],
            iptc: ['ObjectName', 'Headline'],
            xmp: ['dc:title', 'photoshop:Headline']
        },
        {
            internal: 'seo.description',
            exif: ['0th.XPComment', 'Exif.UserComment'],
            iptc: ['Caption'],
            xmp: ['dc:description']
        },
        {
            internal: 'seo.keywords',
            exif: ['0th.XPKeywords'],
            iptc: ['Keywords'],
            xmp: ['dc:subject']
        },
        
        // Rights
        {
            internal: 'rights.creator',
            exif: ['0th.Artist', '0th.XPAuthor'],
            iptc: ['Byline', 'Writer'],
            xmp: ['dc:creator']
        },
        {
            internal: 'rights.copyright_notice',
            exif: ['0th.Copyright'],
            iptc: ['Copyright Notice'],
            xmp: ['dc:rights']
        },
        {
            internal: 'rights.credit',
            iptc: ['Credit'],
            xmp: ['photoshop:Credit']
        },
        {
            internal: 'rights.website',
            xmp: ['xmpRights:WebStatement']
        },

        // Generation
        {
            internal: 'generation.software',
            exif: ['0th.Software'],
            iptc: ['Digital Source Type'],
            xmp: ['xmp:CreatorTool']
        },
        {
            internal: 'generation.generator',
            xmp: ['photoshop:Source']
        },
        {
            internal: 'generation.image_id',
            exif: ['Exif.ImageUniqueID'],
            xmp: ['xmpMM:DocumentID', 'xmp:Identifier']
        },
        {
            internal: 'generation.prompt_id',
            xmp: ['xmpMM:OriginalDocumentID']
        },
        {
            internal: 'processing.processing_hash',
            xmp: ['xmpMM:InstanceID']
        },

        // Location
        {
            internal: 'location.city',
            iptc: ['City'],
            xmp: ['photoshop:City']
        },
        {
            internal: 'location.state',
            iptc: ['Province'],
            xmp: ['photoshop:State']
        },
        {
            internal: 'location.country',
            iptc: ['Country'],
            xmp: ['photoshop:Country']
        },

        // Dates
        {
            internal: 'dates.created_at',
            exif: ['Exif.DateTimeOriginal', 'Exif.DateTimeDigitized', '0th.DateTime'],
            xmp: ['xmp:CreateDate']
        },
        {
            internal: 'dates.modified_at',
            xmp: ['xmp:ModifyDate']
        },
        {
            internal: 'dates.metadata_date',
            xmp: ['xmp:MetadataDate']
        }
    ];

    /**
     * Resolves a dot-notation path on an object.
     */
    function getByPath(obj, path) {
        return path.split('.').reduce((acc, part) => acc && acc[part], obj);
    }

    /**
     * Map the internal metadata to a specific target standard.
     * @param {Object} metadata - The validated internal metadata object
     * @param {string} standard - 'exif', 'iptc', or 'xmp'
     * @returns {Object} Target-specific dictionary
     */
    function mapMetadata(metadata, standard) {
        const result = {};

        for (const entry of MAP) {
            const val = getByPath(metadata, entry.internal);
            // Skip empty/null/undefined
            if (val === undefined || val === null || val === '') continue;
            if (Array.isArray(val) && val.length === 0) continue;

            const targetKeys = entry[standard];
            if (!targetKeys) continue;

            for (const key of targetKeys) {
                // If collision on target key, prefer arrays or overwrite
                if (!result[key]) {
                    result[key] = val;
                } else if (Array.isArray(result[key]) && Array.isArray(val)) {
                    result[key] = [...new Set([...result[key], ...val])];
                } else if (Array.isArray(result[key]) && !Array.isArray(val)) {
                    if (!result[key].includes(val)) result[key].push(val);
                } else {
                    // Overwrite string (first-one-wins usually handled by MAP order, but here last wins)
                    result[key] = val; 
                }
            }
        }

        return result;
    }

    globalThis.bulkygenMetadataMapper = {
        mapMetadata,
        MAP
    };
})();
