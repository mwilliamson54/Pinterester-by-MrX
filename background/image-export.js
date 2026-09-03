// Part of background.js, split out for readability. Runs in the same
// service-worker global scope as background.js and the other
// background/*.js files (loaded via importScripts — NOT ES modules),
// so everything here shares state (isRunning, isPaused, etc.) with them
// exactly as it did when this was all one file.



// Fetch cross-origin image as base64 (background script can bypass CORS)
async function fetchImageAsBase64(imageUrl) {
  try {
    // NOTE on the fallback chain below: credentials:'include' against a CDN
    // that answers with a wildcard `Access-Control-Allow-Origin: *` (very
    // common — S3/Wasabi/CloudFront/Facebook/Twitter CDNs, etc.) doesn't
    // come back as an HTTP error response at all. The browser refuses it
    // at the network layer and fetch() throws a bare
    // "TypeError: Failed to fetch" with no status code to inspect. The old
    // code only fell back to a credential-less retry when it saw
    // response.status === 403, so in this (very common) failure mode the
    // first fetch would throw before a response even existed, jump
    // straight to the outer catch, and the 403-triggered fallback below it
    // never ran. Each attempt is now wrapped individually so a thrown
    // TypeError falls through to the next attempt exactly like a 403 does.
    let response = null;
    let lastError = null;

    // Attempt 1: credentialed CORS request (needed for auth-gated assets
    // like Grok videos that actually require the session cookie).
    try {
      response = await fetch(imageUrl, { mode: 'cors', credentials: 'include' });
    } catch (err) {
      lastError = err;
      response = null;
    }

    // Attempt 2: same request without credentials — this is the one that
    // actually recovers most real-world CDN failures, whether attempt 1
    // failed with a 403 response OR threw outright.
    if (!response || (!response.ok && response.status === 403)) {
      console.log('Retrying fetch without credentials...');
      try {
        response = await fetch(imageUrl, { mode: 'cors', credentials: 'omit' });
        lastError = null;
      } catch (err) {
        lastError = err;
        response = response || null;
      }
    }

    if (!response) {
      // Both attempts threw a network-level error — nothing to fall back
      // to (no-cors mode returns an opaque, unreadable body, so it can't
      // recover real image bytes and isn't worth attempting).
      throw lastError || new Error('Failed to fetch image (network error)');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const blob = await response.blob();

    // Check if blob is valid
    if (blob.size < 100) {
      throw new Error('Response too small, likely failed');
    }

    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Convert to base64
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    const base64 = btoa(binary);

    // Determine mime type
    const contentType = response.headers.get('content-type') || 'image/png';
    const mimeType = contentType.split(';')[0].trim();

    return {
      success: true,
      dataUrl: `data:${mimeType};base64,${base64}`
    };
  } catch (error) {
    console.error('Background fetch error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

function notifyPopup(action, data) {
  ext.runtime.sendMessage({ action, ...data }).catch(() => {
    // Popup might be closed, ignore error
  });
}

// Listen for downloads (if needed for tracking)
ext.downloads?.onChanged?.addListener((delta) => {
  if (delta.state && delta.state.current === 'complete') {
    console.log('Download completed:', delta.id);
  }
});

// Save generated image for later ZIP download
async function saveGeneratedImage(imageData, prompt) {
  const itemId = arguments.length >= 3 ? arguments[2] : null;
  const meta = arguments.length >= 4 ? arguments[3] : undefined;
  const timestamp = Date.now();

  const id = `${timestamp}-${Math.random().toString(16).slice(2)}`;
  const { blob, mime } = dataUrlToBlob(imageData);

  // Log what type of media we're saving
  const mediaType = mime.startsWith('video/') ? 'video' : 'image';
  console.log(`💾 Saving ${mediaType} (${mime}), size: ${blob.size} bytes`);

  // Persist full image bytes in IndexedDB (avoids storage.local quota).
  if (!globalThis.bulkygenImageStore) throw new Error('IndexedDB image store not available');
  await globalThis.bulkygenImageStore.putImage({
    id,
    itemId,
    prompt,
    meta,
    timestamp,
    mime,
    blob
  });

  // Persist only lightweight metadata in storage.local.
  const data = await ext.storage.local.get(['generatedImages']);
  const images = data.generatedImages || [];
  images.push({ id, prompt, itemId, meta, timestamp, mime });
  await ext.storage.local.set({ generatedImages: images });

  notifyPopup('imageSaved', { itemId });

  // Auto-download this image the instant it's captured (no end-of-run ZIP step).
  await autoDownloadMedia(imageData, prompt, mime, timestamp);
}

// Auto-download a freshly captured image/video into a "bulkygen images" folder.
// Files are numbered in strict sequence (0001, 0002, 0003 ...) and include the
// a plain serial number + a timestamp, e.g.:  bulkygen images/1-20260619-084233.png
// Saves are awaited one-at-a-time by the generation loop, so downloads fire in
// order. Runs entirely from the background service worker, so it keeps working
// no matter which tab is focused.
async function autoDownloadMedia(imageData, prompt, mime, timestamp) {
  try {
    if (!ext.downloads || !ext.downloads.download) return;
    if (!imageData) return;

    // Persisted serial number so numbering survives service-worker restarts.
    const seqData = await ext.storage.local.get(['bulkygenDownloadSeq']);
    const seq = (Number(seqData.bulkygenDownloadSeq) || 0) + 1;
    await ext.storage.local.set({ bulkygenDownloadSeq: seq });

    // Pick a file extension from the MIME type.
    const m = (mime || '').toLowerCase();
    let extName = 'png';
    if (m.includes('mp4')) extName = 'mp4';
    else if (m.includes('webm')) extName = 'webm';
    else if (m.includes('video/')) extName = 'mp4';
    else if (m.includes('jpeg') || m.includes('jpg')) extName = 'jpg';
    else if (m.includes('webp')) extName = 'webp';
    else if (m.includes('png')) extName = 'png';

    const serial = String(seq); // plain numbers: 1, 2, 3 ... 10, 11 ... 100
    const stamp = formatTimestampForName(timestamp || Date.now());
    const filename = `bulkygen images/${serial}-${stamp}.${extName}`;

    // Prefer a blob URL; fall back to the raw data URL if needed.
    let url = imageData;
    let createdBlobUrl = false;
    try {
      const { blob } = dataUrlToBlob(imageData);
      if (globalThis.URL && typeof globalThis.URL.createObjectURL === 'function') {
        url = globalThis.URL.createObjectURL(blob);
        createdBlobUrl = true;
      }
    } catch (e) { /* use data URL */ }

    await ext.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    console.log(`\u2B07\uFE0F Auto-downloaded: ${filename}`);

    if (createdBlobUrl) {
      setTimeout(() => { try { globalThis.URL.revokeObjectURL(url); } catch (e) { } }, 60000);
    }
  } catch (e) {
    console.error('Auto-download failed (continuing):', e);
  }
}

// Compact LOCAL-time stamp for filenames: YYYYMMDD-HHMMSS
function formatTimestampForName(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function dataUrlToBlob(dataUrl) {
  const str = (dataUrl || '').toString();
  const match = /^data:([^;]+);base64,/.exec(str);
  // Extract MIME type from data URL (e.g., video/mp4, image/png)
  let mime = match && match[1] ? match[1] : 'image/png';
  // Ensure we preserve video MIME types
  if (!mime.includes('/')) {
    mime = 'image/png'; // fallback
  }
  const bytes = dataUrlToBytes(str);
  return { blob: new Blob([bytes], { type: mime }), mime };
}

async function clearAllGeneratedImages() {
  try {
    if (globalThis.bulkygenImageStore) {
      await globalThis.bulkygenImageStore.clearAll();
    }
  } finally {
    await ext.storage.local.set({ generatedImages: [] });
  }
}

// Create and download ZIP file with all generated images
async function createAndDownloadZipFromDb() {
  if (!globalThis.bulkygenImageStore) {
    throw new Error('IndexedDB image store not available');
  }

  const records = await globalThis.bulkygenImageStore.getAllImages();
  if (!records || records.length === 0) throw new Error('No images to download');

  try {
    const providers = new Set(
      records
        .map(r => (r && r.meta && r.meta.provider ? String(r.meta.provider) : ''))
        .filter(Boolean)
    );
    const providerPrefix = providers.size === 1 ? Array.from(providers)[0] : 'bulkgen';

    // Stable order by timestamp.
    records.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const files = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const pfx = (r && r.meta && r.meta.provider) ? String(r.meta.provider) : providerPrefix;

      // Detect proper file extension from MIME type
      let extName = 'png'; // default
      const mimeStr = r && r.mime ? String(r.mime).toLowerCase() : '';
      if (mimeStr.includes('video/mp4') || mimeStr.includes('mp4')) {
        extName = 'mp4';
      } else if (mimeStr.includes('video/webm') || mimeStr.includes('webm')) {
        extName = 'webm';
      } else if (mimeStr.includes('video/')) {
        // Generic video type, default to mp4
        extName = 'mp4';
      } else if (mimeStr.includes('image/jpeg') || mimeStr.includes('jpeg') || mimeStr.includes('jpg')) {
        extName = 'jpg';
      } else if (mimeStr.includes('image/png') || mimeStr.includes('png')) {
        extName = 'png';
      }

      const filename = `${pfx}-${i + 1}-${sanitizeFilename(r.prompt || 'media')}.${extName}`;
      const ab = await (r.blob ? r.blob.arrayBuffer() : Promise.resolve(new ArrayBuffer(0)));
      const bytes = new Uint8Array(ab);
      files.push({ filename, bytes });
    }

    const zipBytes = createZipStore(files);

    // Download ZIP
    const safeBytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
    const canUseBlobUrl = !!globalThis.URL && typeof globalThis.URL.createObjectURL === 'function';

    let url;
    if (canUseBlobUrl) {
      const zipBlob = new Blob([safeBytes], { type: 'application/zip' });
      url = globalThis.URL.createObjectURL(zipBlob);
    } else {
      // MV3 service workers can lack URL.createObjectURL in some environments.
      // Fallback to a data URL.
      const base64 = bytesToBase64(safeBytes);
      url = `data:application/zip;base64,${base64}`;
    }

    const downloadId = await ext.downloads.download({
      url,
      filename: `${providerPrefix}-bulk-${Date.now()}.zip`,
      saveAs: true
    });

    // Clean up
    if (canUseBlobUrl) {
      setTimeout(() => globalThis.URL.revokeObjectURL(url), 60000);
    }

    return { success: true, downloadId };

  } catch (error) {
    console.error('ZIP creation error:', error);
    throw error;
  }
}

function bytesToBase64(bytes) {
  // Convert Uint8Array -> base64 without blowing the call stack.
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function dataUrlToBytes(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.includes(',')) {
    throw new Error('Invalid image data');
  }
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createZipStore(files) {
  const encoder = new TextEncoder();
  const fileRecords = [];
  let offset = 0;
  const localParts = [];

  for (const file of files) {
    const nameBytes = encoder.encode(file.filename);
    const dataBytes = file.bytes;
    const crc = crc32(dataBytes);

    // Local file header
    const localHeader = new Uint8Array(30 + nameBytes.length);
    writeU32(localHeader, 0, 0x04034b50);
    writeU16(localHeader, 4, 20); // version needed
    writeU16(localHeader, 6, 0); // flags
    writeU16(localHeader, 8, 0); // compression: store
    writeU16(localHeader, 10, 0); // mod time
    writeU16(localHeader, 12, 0); // mod date
    writeU32(localHeader, 14, crc);
    writeU32(localHeader, 18, dataBytes.length);
    writeU32(localHeader, 22, dataBytes.length);
    writeU16(localHeader, 26, nameBytes.length);
    writeU16(localHeader, 28, 0); // extra length
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);

    fileRecords.push({
      nameBytes,
      crc,
      size: dataBytes.length,
      offset
    });

    offset += localHeader.length + dataBytes.length;
  }

  const centralStart = offset;
  const centralParts = [];
  for (const rec of fileRecords) {
    const centralHeader = new Uint8Array(46 + rec.nameBytes.length);
    writeU32(centralHeader, 0, 0x02014b50);
    writeU16(centralHeader, 4, 20); // version made by
    writeU16(centralHeader, 6, 20); // version needed
    writeU16(centralHeader, 8, 0); // flags
    writeU16(centralHeader, 10, 0); // compression
    writeU16(centralHeader, 12, 0);
    writeU16(centralHeader, 14, 0);
    writeU32(centralHeader, 16, rec.crc);
    writeU32(centralHeader, 20, rec.size);
    writeU32(centralHeader, 24, rec.size);
    writeU16(centralHeader, 28, rec.nameBytes.length);
    writeU16(centralHeader, 30, 0); // extra
    writeU16(centralHeader, 32, 0); // comment
    writeU16(centralHeader, 34, 0); // disk
    writeU16(centralHeader, 36, 0); // int attrs
    writeU32(centralHeader, 38, 0); // ext attrs
    writeU32(centralHeader, 42, rec.offset);
    centralHeader.set(rec.nameBytes, 46);
    centralParts.push(centralHeader);
    offset += centralHeader.length;
  }

  const centralSize = offset - centralStart;

  const end = new Uint8Array(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 4, 0);
  writeU16(end, 6, 0);
  writeU16(end, 8, fileRecords.length);
  writeU16(end, 10, fileRecords.length);
  writeU32(end, 12, centralSize);
  writeU32(end, 16, centralStart);
  writeU16(end, 20, 0);

  return concatBytes([...localParts, ...centralParts, end]);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function writeU16(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

// Sanitize filename
function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
}