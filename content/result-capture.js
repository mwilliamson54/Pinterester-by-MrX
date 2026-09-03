// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;

 // end __BULKYGEN_CS_LISTENER__ guard

function collectResultElements() {
  const results = [];
  const seen = new Set();

  function push(el) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    results.push(el);
  }

  function scan(root) {
    try {
      // Collect img, canvas, and video elements for all providers
      // (Grok and Meta AI both generate videos)
      root.querySelectorAll('img,canvas,video').forEach(push);
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) scan(el.shadowRoot);
      });
    } catch {
      // ignore
    }
  }

  scan(document);
  return results;
}

function elementKey(el) {
  if (!el) return '';
  if (el.tagName === 'IMG') {
    const src = el.currentSrc || el.src || '';
    // For blob/data URLs, include dimensions to detect when a new image is loaded
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      const w = el.naturalWidth || el.width || 0;
      const h = el.naturalHeight || el.height || 0;
      return `img:${src}:${w}x${h}`;
    }
    return `img:${src}`;
  }
  if (el.tagName === 'CANVAS') {
    const w = el.width || 0;
    const h = el.height || 0;
    return `canvas:${w}x${h}`;
  }
  if (el.tagName === 'VIDEO') {
    const src = el.currentSrc || el.src || '';
    const w = el.videoWidth || el.width || 0;
    const h = el.videoHeight || el.height || 0;
    return `video:${src}:${w}x${h}`;
  }
  return '';
}

function pickBestImageElement(elements, excludeKeys) {
  const candidates = [];
  for (const el of elements) {
    const key = elementKey(el);
    if (!key) continue;
    if (excludeKeys && excludeKeys.has(key)) continue;

    let score = 0;
    if (el.tagName === 'IMG') {
      const src = el.currentSrc || el.src || '';

      // Skip tiny icons, avatars, and UI images
      const w = el.naturalWidth || el.width || 0;
      const h = el.naturalHeight || el.height || 0;
      // Only consider images that are reasonably large (likely generated content)
      if (w < 200 || h < 200) continue;
      // Skip common UI image patterns
      if (src.includes('avatar') || src.includes('icon') || src.includes('logo')) continue;
      // Skip preview/placeholder images (Grok shows preview_image.jpg during generation)
      if (src.includes('preview_image') || src.includes('placeholder') || src.includes('thumbnail')) continue;
      // Skip static marketing/demo assets that live on the same CDN as real
      // results (DIGEN serves /demo/ and /apps/ promo images from cloudfront).
      if (/\/(demo|apps|landing|marketing|samples?|examples?)\//i.test(src)) continue;
      // Prefer blob/data URLs and CDN URLs (generated images)
      score = w * h;
      if (src.startsWith('blob:') || src.startsWith('data:')) score += 100000;
      if (src.includes('googleusercontent') || src.includes('cdn')) score += 50000;
      // Meta AI: boost score for fbcdn/scontent URLs (generated images)
      if (src.includes('fbcdn') || src.includes('scontent') || src.includes('fbsbx')) score += 80000;
      // Grok: boost score for grok.com/assets.grok.com URLs (generated images)
      if (src.includes('grok.com') || src.includes('assets.grok') || src.includes('twimg')) score += 80000;
      // DIGEN AI: boost score for r2.dev/digen/cloudflare URLs (generated images)
      if (NS.PROVIDER === 'digen' && (src.includes('r2.dev') || src.includes('digen') || src.includes('cloudflare') || src.includes('cloudfront'))) score += 100000;
    } else if (el.tagName === 'VIDEO') {
      // Check VIDEO before CANVAS - videos are preferred for Grok
      const src = el.currentSrc || el.src || '';
      const w = el.videoWidth || el.width || 0;
      const h = el.videoHeight || el.height || 0;
      // Only consider videos that are reasonably large
      if (w < 200 || h < 200) continue;
      // Check if video has any data (readyState >= 1 means has metadata)
      if (el.readyState < 1) continue;
      // Skip videos that don't have a valid source
      if (!src || src === 'about:blank') continue;
      // Boost score for videos significantly - prefer over canvas
      score = w * h + 300000;
      // Meta AI: boost score for fbcdn/scontent URLs (generated videos)
      if (src.includes('fbcdn') || src.includes('scontent') || src.includes('fbsbx')) score += 100000;
      // Grok: boost score for grok.com/assets.grok.com URLs (generated videos) or blob URLs
      if (src.includes('grok.com') || src.includes('assets.grok') || src.includes('twimg') || src.startsWith('blob:')) score += 150000;
      // DIGEN AI: boost score for r2.dev/digen/cloudflare URLs (generated videos)
      if (NS.PROVIDER === 'digen' && (src.includes('r2.dev') || src.includes('digen') || src.includes('cloudflare') || src.includes('cloudfront'))) score += 150000;
    } else if (el.tagName === 'CANVAS') {
      const w = el.width || 0;
      const h = el.height || 0;
      if (w < 200 || h < 200) continue;
      score = w * h;
      // For Grok: lower canvas priority since we prefer video elements
      // (canvas often shows black frame while video is playing)
      if (NS.PROVIDER === 'grok') score -= 50000;
    }
    if (score > 0) candidates.push({ el, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.el || null;
}

// For Meta AI: get all 4 results (images or videos)
function getAllMetaAIResults(elements, excludeKeys) {
  const candidates = [];
  for (const el of elements) {
    const key = elementKey(el);
    if (!key) continue;
    if (excludeKeys && excludeKeys.has(key)) continue;

    let score = 0;

    // Look for video elements
    if (el.tagName === 'VIDEO') {
      const src = el.currentSrc || el.src || '';
      const w = el.videoWidth || el.width || 0;
      const h = el.videoHeight || el.height || 0;
      // Only consider videos that are reasonably large
      if (w < 200 || h < 200) continue;
      score = w * h + 200000; // Prefer videos slightly
    }
    // Look for image elements
    else if (el.tagName === 'IMG') {
      const src = el.currentSrc || el.src || '';
      const w = el.naturalWidth || el.width || 0;
      const h = el.naturalHeight || el.height || 0;
      // Only consider images that are reasonably large
      if (w < 200 || h < 200) continue;
      // Skip tiny icons, avatars, and UI images
      if (src.includes('avatar') || src.includes('icon') || src.includes('static_map')) continue;
      score = w * h;
    }

    if (score > 0) {
      candidates.push({ el, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  // Return top 4 results
  return candidates.slice(0, 4).map(c => c.el);
}

async function waitForNewBestResult(previousKeys, timeoutMs = 300000) {
  const start = Date.now();
  let lastLogTime = 0;
  let foundCandidate = null;
  let stableCount = 0;

  // For Meta AI, we need to wait for all 4 results (images or videos)
  const isMetaAI = NS.PROVIDER === 'metaai';
  const isDigen = NS.PROVIDER === 'digen';
  const requiredCount = isMetaAI ? 4 : 1;

  while (Date.now() - start < timeoutMs) {
    const all = collectResultElements();

    // Log progress every 10 seconds
    if (Date.now() - lastLogTime > 10000) {
      console.log(`🔍 Waiting for new ${isMetaAI ? 'results' : 'result'}... (${Math.round((Date.now() - start) / 1000)}s, found ${all.length} elements, generating=${NS.isStillGenerating()})`);
      lastLogTime = Date.now();
    }

    // Check for content moderation (Grok)
    if (NS.PROVIDER === 'grok' && NS.isContentModerated()) {
      console.log('⚠️ Grok: Content moderated, skipping this prompt');
      return { moderated: true };
    }

    if (isMetaAI) {
      // For Meta AI: wait for all 4 results
      const results = getAllMetaAIResults(all, previousKeys);

      if (results.length >= requiredCount) {
        // Found candidates - wait for them to stabilize
        const resultKeys = results.map(v => elementKey(v)).join('|');
        if (foundCandidate === resultKeys) {
          stableCount++;
          // keys have been stable for 2.5 seconds (5 checks), consider them ready
          if (stableCount >= 5) {
            console.log(`✅ Found ${results.length} stable new results for Meta AI`);
            return results; // Return array of results
          }
        } else {
          foundCandidate = resultKeys;
          stableCount = 1;
          console.log(`🔄 Found ${results.length} candidates, waiting for them to stabilize...`);
        }
      } else {
        foundCandidate = null;
        stableCount = 0;
      }
    } else {
      // For other providers: single image/video
      const best = pickBestImageElement(all, previousKeys);

      // Check if generation is still in progress
      const stillGenerating = NS.isStillGenerating();

      // For Grok: we need to wait for generation to complete (button text changes from "Generating...")
      // The key change: for Grok, we wait for stillGenerating to become FALSE before accepting results
      const isGrok = NS.PROVIDER === 'grok';

      if (stillGenerating) {
        // Generation is in progress - reset and wait
        if (Date.now() - lastLogTime > 5000) {
          console.log('🔄 Still generating... waiting for completion');
          lastLogTime = Date.now();
        }
        foundCandidate = null;
        stableCount = 0;
      } else if (best) {
        // Found a candidate and generation appears complete - wait for it to stabilize
        // For DIGEN AI: much faster stabilization - only 2 checks (1 second total)
        // For Grok: reduced stabilization time - we capture immediately after generation (no upscale wait)
        const requiredStable = isDigen ? 2 : (isGrok ? 3 : 3);
        const bestKey = elementKey(best);
        if (foundCandidate === bestKey) {
          stableCount++;
          // Image/video has been stable for required checks, consider it ready
          if (stableCount >= requiredStable) {
            console.log('✅ Found stable new result:', best.tagName, best.naturalWidth || best.videoWidth || best.width, 'x', best.naturalHeight || best.videoHeight || best.height);

            if (isGrok) {
              console.log('🎬 Grok: Result found, starting upscale process...');

              // RETRY LOOP FOR UPSCALE BUTTON
              // Sometimes the button takes a moment to appear after generation "completes"
              let upscaleClicked = false;
              for (let attempt = 0; attempt < 10; attempt++) {
                console.log(`🎬 Grok Upscale Attempt ${attempt + 1}/10...`);
                upscaleClicked = await NS.clickGrokUpscaleButton();
                if (upscaleClicked) break;

                // If not found, check if we are still generating (false positive completion?)
                if (NS.isStillGenerating()) {
                  console.log('🔄 Grok: Generation indicator reappeared, waiting...');
                  foundCandidate = null; // Reset candidate
                  break; // Break upscale loop to go back to main wait loop
                }

                await NS.waitUnthrottled(1000);
              }

              if (upscaleClicked) {
                console.log('⏳ Grok: Waiting for upscale to complete...');
                const upscaleSuccess = await NS.waitForGrokUpscaleComplete();
                if (upscaleSuccess) {
                  console.log('✅ Grok: Upscale completed successfully');
                  await NS.waitUnthrottled(2000);
                  const refreshedMsg = '🔄 Grok: Re-checking video element after upscale...';
                  console.log(refreshedMsg);
                } else {
                  console.log('⚠️ Grok: Upscale wait timed out or failed, proceeding with current result');
                }
              } else if (foundCandidate === null) {
                // We reset because generation reappeared
                console.log('🔄 Grok: Resuming generation wait...');
                continue;
              } else {
                console.log('⚠️ Grok: Upscale button NOT found after retries. Proceeding with standard capture.');
                // We proceed, but logs will show we failed to upscale
              }
            }

            return best; // Return single element
          }
        } else {
          foundCandidate = bestKey;
          stableCount = 1;
          console.log('🔄 Found new candidate, waiting for it to stabilize...', isGrok ? '(Grok: waiting for generation/upscale)' : (isDigen ? '(DIGEN: fast capture)' : ''));
        }
      } else {
        // No new candidate found in snapshot diff
        foundCandidate = null;
        stableCount = 0;

        // DIGEN AI fallback: if no new elements found after 15 seconds, 
        // grab the largest available image/video (DIGEN may update existing elements)
        if (isDigen && (Date.now() - start) > 15000) {
          console.log('🔍 DIGEN: No new elements found, trying fallback to largest image...');
          // Get the single largest image ignoring the snapshot
          const allCandidates = [];
          for (const el of all) {
            let score = 0;
            if (el.tagName === 'IMG') {
              const src = el.currentSrc || el.src || '';
              const w = el.naturalWidth || el.width || 0;
              const h = el.naturalHeight || el.height || 0;
              if (w < 200 || h < 200) continue;
              if (src.includes('avatar') || src.includes('icon') || src.includes('logo')) continue;
              if (/\/(demo|apps|landing|marketing|samples?|examples?)\//i.test(src)) continue;
              score = w * h;
              if (src.includes('r2.dev') || src.includes('digen') || src.includes('cloudflare') || src.includes('cloudfront')) score += 100000;
            } else if (el.tagName === 'VIDEO') {
              const src = el.currentSrc || el.src || '';
              const w = el.videoWidth || el.width || 0;
              const h = el.videoHeight || el.height || 0;
              if (w < 200 || h < 200) continue;
              score = w * h + 300000;
              if (src.includes('r2.dev') || src.includes('digen') || src.includes('cloudflare') || src.includes('cloudfront')) score += 150000;
            }
            if (score > 0) allCandidates.push({ el, score });
          }

          if (allCandidates.length > 0) {
            allCandidates.sort((a, b) => b.score - a.score);
            const bestFallback = allCandidates[0].el;
            console.log('✅ DIGEN fallback: Found largest element:', bestFallback.tagName,
              bestFallback.naturalWidth || bestFallback.videoWidth || bestFallback.width, 'x',
              bestFallback.naturalHeight || bestFallback.videoHeight || bestFallback.height);
            return bestFallback;
          }
        }
      }
    }

    await NS.waitUnthrottled(isDigen ? 80 : 150); // fast polling for all providers
  }

  console.log(`⚠️ Timeout waiting for new ${isMetaAI ? 'videos' : 'image'}`);
  return null;
}

// Helper to prevent background tab throttling using Web Audio API silence
// This forces the browser to keep the tab execution priority high
function preventBackgroundThrottling() {
  try {
    if (!window.AudioContext && !window.webkitAudioContext) return () => { };

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Near-silent, but loud enough that Chrome flags the tab as "audible" --
    // which is what actually exempts the page from background timer throttling.
    // 18 kHz is inaudible to virtually everyone, and the gain is tiny.
    gainNode.gain.value = 0.003;
    oscillator.frequency.value = 18000;

    let started = false;
    let gestureHandler = null;

    const startSilently = () => {
      // Browsers block AudioContext until a user gesture. Resume first, then
      // start the oscillator only once the context is actually running, so we
      // never trigger the "AudioContext was not allowed to start" warning.
      const tryStart = () => {
        if (started || ctx.state !== 'running') return;
        try {
          oscillator.start();
          started = true;
          console.log('🔊 Background keep-alive active (silent audio)');
        } catch (e) { /* already started */ }
      };
      if (ctx.state === 'running') {
        tryStart();
      } else {
        // Resume quietly; ignore the rejection that happens without a gesture
        ctx.resume().then(tryStart).catch(() => { });
        // Retry on the next real user gesture
        gestureHandler = () => { ctx.resume().then(tryStart).catch(() => { }); };
        window.addEventListener('pointerdown', gestureHandler, { once: true, capture: true });
        window.addEventListener('keydown', gestureHandler, { once: true, capture: true });
      }
    };

    startSilently();

    // Re-assert audio whenever the tab is hidden/shown so the browser keeps the
    // page off the background-throttle list while we switch tabs/windows/apps.
    const onVisibility = () => {
      ctx.resume().then(() => {
        if (!started && ctx.state === 'running') {
          try { oscillator.start(); started = true; } catch (e) { }
        }
      }).catch(() => { });
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility, true);
    window.addEventListener('blur', onVisibility, true);

    // Self-heal: if the browser suspends the context (or it never resumed for
    // lack of a gesture), keep retrying so the tab stays audible & unthrottled.
    const healTimer = setInterval(() => {
      if (ctx.state !== 'running') {
        ctx.resume().then(() => {
          if (!started && ctx.state === 'running') {
            try { oscillator.start(); started = true; } catch (e) { }
          }
        }).catch(() => { });
      }
    }, 1500);

    return () => {
      try {
        clearInterval(healTimer);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('focus', onVisibility, true);
        window.removeEventListener('blur', onVisibility, true);
        if (gestureHandler) {
          window.removeEventListener('pointerdown', gestureHandler, { capture: true });
          window.removeEventListener('keydown', gestureHandler, { capture: true });
        }
        if (started) { try { oscillator.stop(); } catch (e) { } }
        ctx.close();
        console.log('🔇 Background keep-alive stopped');
      } catch (e) { }
    };
  } catch (e) {
    console.log('Failed to start background keep-alive:', e);
    return () => { };
  }
}

// Helper to send completion notification
async function notifyCompletion(count, successCount) {
  try {
    const title = 'BulkyGen Complete';
    const message = `Finished processing ${count} items. ${successCount} successful.`;

    // Method 1: Extension notification
    await NS.ext.runtime.sendMessage({
      action: "showNotification",
      title: title,
      message: message
    }).catch(() => { });

    // Method 2: Browser Notification API
    if (typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') {
        new Notification(title, { body: message });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            new Notification(title, { body: message });
          }
        });
      }
    }
  } catch (e) {
    console.log('Notification failed:', e);
  }
}

// Main generation function
function maybeWarnAboutFlowModel() {
  if (NS.PROVIDER !== 'flow') return;
  const required = NS.PROVIDERS.flow?.requiredModelText;
  if (!required) return;

  try {
    const hay = NS.normalizeText(document.body?.innerText || '');
    if (!hay.includes(required)) {
      console.warn('⚠️ Flow: Nano Banana model not detected in page text. If needed, select it in Flow before starting.');
    }
  } catch {
    // ignore
  }
}
  // ── Exports for other content-script module files ──
  NS.collectResultElements = collectResultElements;
  NS.elementKey = elementKey;
  NS.pickBestImageElement = pickBestImageElement;
  NS.waitForNewBestResult = waitForNewBestResult;
  NS.preventBackgroundThrottling = preventBackgroundThrottling;
  NS.maybeWarnAboutFlowModel = maybeWarnAboutFlowModel;
})();
