// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;



// Direct image download
async function downloadImageDirectly(imageUrl, filename) {
  try {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `${NS.PROVIDER}-${sanitizeFilename(filename)}-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('Image downloaded directly');
  } catch (error) {
    console.error('Direct download failed:', error);
  }
}

// Get image as base64
async function getImageAsBase64(imageUrl, imgElement = null) {
  // First try fetch (works for same-origin and blob URLs)
  try {
    const response = await fetch(imageUrl, { mode: 'cors' });
    if (response.ok) {
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
  } catch (error) {
    console.log('Fetch failed, trying background script fallback:', error.message);
  }

  // Second: Use background script to fetch (bypasses CORS in service worker)
  try {
    const result = await NS.ext.runtime.sendMessage({
      action: 'fetchImageAsBase64',
      imageUrl: imageUrl
    });
    if (result && result.success && result.dataUrl) {
      console.log('✅ Image fetched via background script');
      return result.dataUrl;
    }
    if (result && !result.success) {
      console.log('Background fetch failed:', result.error);
    }
  } catch (bgError) {
    console.log('Background script fetch failed:', bgError.message);
  }

  // Fallback: draw to canvas (works for most cross-origin images loaded by the page)
  if (imgElement && imgElement.tagName === 'IMG') {
    try {
      const canvas = document.createElement('canvas');
      const w = imgElement.naturalWidth || imgElement.width || 512;
      const h = imgElement.naturalHeight || imgElement.height || 512;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgElement, 0, 0, w, h);
      return canvas.toDataURL('image/png');
    } catch (canvasError) {
      console.error('Canvas fallback also failed:', canvasError.message);
    }
  }

  throw new Error('Failed to convert image to base64 - image may be cross-origin protected');
}

// Get video as base64 (for Meta AI videos and Grok videos)
async function getVideoAsBase64(videoUrl, videoElement = null) {
  console.log('📹 Fetching video from URL:', videoUrl);

  // For Grok videos: If it's a blob URL and we have a video element, try to capture the video source directly
  if (videoElement && videoElement.tagName === 'VIDEO') {
    // First, make sure video has loaded
    if (videoElement.readyState < 2) {
      console.log('⏳ Waiting for video to load...');
      await new Promise((resolve) => {
        const onLoaded = () => {
          videoElement.removeEventListener('loadeddata', onLoaded);
          resolve();
        };
        videoElement.addEventListener('loadeddata', onLoaded);
        // Timeout after 10 seconds
        setTimeout(resolve, 10000);
      });
    }
  }

  // First try fetch (works for same-origin and blob URLs)
  try {
    const response = await fetch(videoUrl, { mode: 'cors' });
    if (response.ok) {
      const blob = await response.blob();
      console.log('✅ Video fetched successfully, MIME type:', blob.type, 'size:', blob.size);
      // Skip if blob is too small (likely failed or placeholder)
      if (blob.size < 1000) {
        console.log('⚠️ Video blob is too small, might be placeholder');
        throw new Error('Video blob too small');
      }
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          console.log('✅ Video converted to base64');
          resolve(reader.result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
  } catch (error) {
    console.log('Video fetch failed, trying fallbacks:', error.message);
  }

  // Second: Use background script to fetch (bypasses CORS in service worker)
  try {
    const result = await NS.ext.runtime.sendMessage({
      action: 'fetchImageAsBase64', // Reuse the same endpoint for videos
      imageUrl: videoUrl
    });
    if (result && result.success && result.dataUrl) {
      console.log('✅ Video fetched via background script');
      return result.dataUrl;
    }
    if (result && !result.success) {
      console.log('Background fetch failed:', result.error);
    }
  } catch (bgError) {
    console.log('Background script fetch failed:', bgError.message);
  }

  // Third: Try direct blob URL conversion
  if (videoElement && videoElement.src && videoElement.src.startsWith('blob:')) {
    try {
      const response = await fetch(videoElement.src);
      const blob = await response.blob();
      if (blob.size >= 1000) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch (blobError) {
      console.error('Blob URL fetch failed:', blobError.message);
    }
  }

  // Fourth fallback: Capture a frame from the video element as an image
  if (videoElement && videoElement.tagName === 'VIDEO') {
    console.log('📹 Trying to capture video frame as fallback...');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = videoElement.videoWidth || videoElement.width || 1280;
      canvas.height = videoElement.videoHeight || videoElement.height || 720;
      const ctx = canvas.getContext('2d');

      // Seek to first frame if video hasn't started
      if (videoElement.currentTime === 0 && videoElement.duration > 0) {
        videoElement.currentTime = 0.1;
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const frameData = canvas.toDataURL('image/png');

      // Check if frame is valid (not all black/transparent)
      const imageData = ctx.getImageData(0, 0, Math.min(100, canvas.width), Math.min(100, canvas.height));
      let hasContent = false;
      for (let i = 0; i < imageData.data.length; i += 4) {
        if (imageData.data[i] > 10 || imageData.data[i + 1] > 10 || imageData.data[i + 2] > 10) {
          hasContent = true;
          break;
        }
      }

      if (hasContent) {
        console.log('✅ Video frame captured as PNG');
        return frameData;
      } else {
        console.log('⚠️ Captured frame appears to be black');
      }
    } catch (frameError) {
      console.error('Video frame capture failed:', frameError.message);
    }
  }

  throw new Error('Failed to convert video to base64 - video may be cross-origin protected');
}

// Special handler for Grok images (require authentication from imagine-public.x.ai)
async function getGrokImageAsBase64(imageUrl, imgElement = null) {
  console.log('📸 Grok: Fetching image from URL:', imageUrl);

  // Method 1: Try fetch with credentials (content script can access cookies)
  try {
    const response = await fetch(imageUrl, {
      mode: 'cors',
      credentials: 'include'
    });
    if (response.ok) {
      const blob = await response.blob();
      if (blob.size > 1000) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    }
  } catch (fetchError) {
    console.log('Fetch with credentials failed:', fetchError.message);
  }

  // Method 2: Try XMLHttpRequest with credentials
  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', imageUrl, true);
      xhr.responseType = 'blob';
      xhr.withCredentials = true;

      xhr.onload = function () {
        if (xhr.status === 200 || xhr.status === 206) {
          const blob = xhr.response;
          if (blob && blob.size > 1000) {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          } else {
            reject(new Error('Image blob too small'));
          }
        } else {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error('XHR failed'));
      xhr.send();
    });

    console.log('✅ Grok: Image fetched via XHR with credentials');
    return data;
  } catch (xhrError) {
    console.log('XHR with credentials failed:', xhrError.message);
  }

  // Method 3: Try background script fetch
  try {
    const result = await NS.ext.runtime.sendMessage({
      action: 'fetchImageAsBase64',
      imageUrl: imageUrl
    });
    if (result && result.success && result.dataUrl) {
      console.log('✅ Grok: Image fetched via background script');
      return result.dataUrl;
    }
    if (result && !result.success) {
      console.log('Background fetch failed:', result.error);
    }
  } catch (bgError) {
    console.log('Background script fetch failed:', bgError.message);
  }

  // Method 4: Fall back to regular image capture
  return await getImageAsBase64(imageUrl, imgElement);
}

// Special handler for Grok videos (require authentication)
async function getGrokVideoAsBase64(videoUrl, videoElement = null) {
  console.log('📹 Grok: Fetching video from URL:', videoUrl);

  // Method 1: Try background script fetch FIRST (fastest, bypasses CORS reliably)
  try {
    const result = await NS.ext.runtime.sendMessage({
      action: 'fetchImageAsBase64', // Reuse the same endpoint for videos
      imageUrl: videoUrl
    });
    if (result && result.success && result.dataUrl) {
      console.log('✅ Grok: Video fetched via background script');
      return result.dataUrl;
    }
    if (result && !result.success) {
      console.log('Background fetch failed:', result.error);
    }
  } catch (bgError) {
    console.log('Background script fetch failed:', bgError.message);
  }

  // Method 2: Try fetch with credentials (content script can access cookies)
  try {
    const response = await fetch(videoUrl, {
      mode: 'cors',
      credentials: 'include'
    });
    if (response.ok || response.status === 206) {
      const blob = await response.blob();
      if (blob.size > 1000) {
        console.log('✅ Grok: Video fetched via fetch with credentials');
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    }
  } catch (fetchError) {
    console.log('Fetch with credentials failed:', fetchError.message);
  }

  // Method 3: Try XMLHttpRequest with credentials
  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', videoUrl, true);
      xhr.responseType = 'blob';
      xhr.withCredentials = true; // Important: sends cookies

      xhr.onload = function () {
        // Accept 200 (OK) and 206 (Partial Content) as success
        if (xhr.status === 200 || xhr.status === 206) {
          const blob = xhr.response;
          if (blob && blob.size > 1000) {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          } else {
            reject(new Error('Video blob too small'));
          }
        } else {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error('XHR failed'));
      xhr.send();
    });

    console.log('✅ Grok: Video fetched via XHR with credentials');
    return data;
  } catch (xhrError) {
    console.log('XHR with credentials failed:', xhrError.message);
  }

  // Method 3: Try to find a download link/button on the page for this video
  try {
    // Look for download buttons near the video
    const downloadBtns = document.querySelectorAll('a[download], button[aria-label*="download" i], a[href*="download" i]');
    for (const btn of downloadBtns) {
      const href = btn.href || btn.getAttribute('data-url');
      if (href && (href.includes('generated_video') || href.includes('.mp4'))) {
        console.log('Found download link:', href);
        // Try to fetch this URL
        const response = await fetch(href, { credentials: 'include' });
        if (response.ok) {
          const blob = await response.blob();
          if (blob.size > 1000) {
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          }
        }
      }
    }
  } catch (dlError) {
    console.log('Download link method failed:', dlError.message);
  }

  // Method 4: Fall back to regular video capture (captures a frame as image)
  return await getVideoAsBase64(videoUrl, videoElement);
}

// Sanitize filename
function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}
  // ── Exports for other content-script module files ──
  NS.getImageAsBase64 = getImageAsBase64;
  NS.getVideoAsBase64 = getVideoAsBase64;
  NS.getGrokImageAsBase64 = getGrokImageAsBase64;
  NS.getGrokVideoAsBase64 = getGrokVideoAsBase64;
})();
