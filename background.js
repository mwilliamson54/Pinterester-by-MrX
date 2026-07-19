// Background service worker
importScripts('ext.js');
importScripts('image_store.js');

// ── Pipeline modules ────────────────────────────────────────────────────────
importScripts('modules/logger.js');
importScripts('modules/settings.js');
importScripts('modules/statistics.js');
importScripts('modules/supabase.js');
importScripts('modules/canvas-processor.js');
importScripts('modules/metadata/piexif.js');
importScripts('modules/metadata/metadata-mapper.js');
importScripts('modules/metadata/xmp-serializer.js');
importScripts('modules/metadata/exif-serializer.js');
importScripts('modules/metadata/iptc-serializer.js');
importScripts('modules/metadata/metadata-engine.js');
importScripts('modules/metadata-writer.js');
importScripts('modules/googleAuth.js');
importScripts('modules/googleDrive.js');
importScripts('modules/pipeline.js');

let isRunning = false;
let isPaused = false;
let currentTabId = null;
let loopActive = false; // true while a generation loop runs in THIS worker instance

// ---------------------------------------------------------------------------
// Background resilience: keep the MV3 service worker alive during a run and
// resurrect the loop if the worker is ever killed (e.g. when the user switches
// to another tab / window / app). Without this, a single long image wait can
// outlast the ~30s service-worker idle timeout and silently stop generation.
// ---------------------------------------------------------------------------
const KEEPALIVE_ALARM = 'bulkygen-keepalive';
let swKeepAliveTimer = null;

function startSwKeepAlive() {
  if (swKeepAliveTimer) return;
  // Calling a real extension API on an interval keeps resetting the worker's
  // idle timer so it is never torn down mid-generation.
  swKeepAliveTimer = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; }); } catch (e) { }
  }, 20000);
}
function stopSwKeepAlive() {
  if (swKeepAliveTimer) { clearInterval(swKeepAliveTimer); swKeepAliveTimer = null; }
}
function armKeepAliveAlarm() {
  try { chrome.alarms && chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); } catch (e) { }
}
function disarmKeepAliveAlarm() {
  try { chrome.alarms && chrome.alarms.clear(KEEPALIVE_ALARM); } catch (e) { }
}

// Watchdog: fires even when the tab is backgrounded. Resumes the run from
// storage if the worker had been killed (loopActive === false but isRunning).
if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    try {
      const data = await ext.storage.local.get(['isRunning', 'isPaused', 'genTabId', 'pipelineRunning']);

      // Resurrect the autonomous pipeline if the worker was killed mid-run.
      // (bulkygenPipeline.isRunning lives in memory, so after a worker restart
      // it's always false even though pipelineRunning in storage says it should
      // still be active — that mismatch is exactly the "worker got killed" signal.)
      if (data.pipelineRunning && globalThis.bulkygenPipeline && !globalThis.bulkygenPipeline.isRunning) {
        startSwKeepAlive();
        console.log('\u23f0 Watchdog: resuming autonomous pipeline after worker wake');
        globalThis.bulkygenPipeline.start(true);
      } else if (!data.pipelineRunning && data.isRunning && !loopActive) {
        startSwKeepAlive();
        isPaused = !!data.isPaused;
        console.log('\u23f0 Watchdog: resuming generation after worker wake');
        startGeneration(typeof data.genTabId === 'number' ? data.genTabId : undefined);
      } else if (!data.isRunning && !data.pipelineRunning) {
        disarmKeepAliveAlarm();
        stopSwKeepAlive();
      }
    } catch (e) { }
  });
}

// Re-arm keep-alive whenever the worker spins back up while a run is active.
try {
  ext.storage.local.get(['isRunning', 'pipelineRunning']).then((d) => {
    if (d && (d.isRunning || d.pipelineRunning)) { startSwKeepAlive(); armKeepAliveAlarm(); }
    if (d && d.pipelineRunning && globalThis.bulkygenPipeline && !globalThis.bulkygenPipeline.isRunning) {
      console.log('\u23f0 Startup: resuming autonomous pipeline after worker restart');
      globalThis.bulkygenPipeline.start(true);
    }
  }).catch(() => { });
} catch (e) { }

// Enable native auto-open for the extension side panel.
try {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
} catch (e) {
  console.warn('setPanelBehavior not supported:', e);
}

// Fallback click behavior if side panel isn't completely natively handled by ActionClick.
// Since openPanelOnActionClick is true, the browser SHOULD handle opening the side panel automatically.
// The listener remains mostly empty here, but if needed, we keep it small to avoid conflicts.
chrome.action.onClicked.addListener(async (tab) => {
  console.log('Action icon clicked. Native sidePanel behavior should handle this.');
});

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startGeneration') {
    if (loopActive) {
      console.warn('BulkyGen: startGeneration ignored — a generation loop is already active in this worker (loopActive=true). This is why a pipeline record can hang until its 300s timeout with no logs at all.');
      sendResponse({ started: false, reason: 'loopActive' });
      return false;
    }
    startGeneration().catch((e) => console.error('startGeneration error:', e));
    sendResponse({ started: true });
    return false;
  } else if (message.action === 'stopGeneration') {
    isRunning = false;
    isPaused = false;
    ext.storage.local.set({ isPaused: false }).catch(() => { });
    stopSwKeepAlive();
    disarmKeepAliveAlarm();
    if (currentTabId != null) {
      try { ext.tabs.sendMessage(currentTabId, { action: 'bgKeepAlive', on: false }).catch(() => { }); } catch (e) { }
    }
  } else if (message.action === 'generationResult') {
    // Content script pushed a finished generation result (reliable delivery
    // path for long generations whose response channel may have closed).
    try { __deliverPushedResult(message.itemId, message.result); } catch (e) { /* ignore */ }
    // Also deliver to pipeline if this item originated from the autonomous loop
    try {
      if (globalThis.bulkygenPipeline) {
        globalThis.bulkygenPipeline.deliverGenerationResult(message.itemId, message.result);
      }
    } catch (e) { /* ignore */ }
    return false;
  } else if (message.action === 'startPipeline') {
    if (globalThis.bulkygenPipeline) {
      // Without this, the service worker can be torn down mid-generation
      // (Flow waits can run for minutes) and nothing was resurrecting the
      // autonomous loop — this is what caused it to silently stop.
      startSwKeepAlive();
      armKeepAliveAlarm();
      ext.storage.local.set({ pipelineRunning: true }).catch(() => { });
      globalThis.bulkygenPipeline.start(true); // force=true: bypass autonomousMode check
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Pipeline module not loaded' });
    }
    return false;
  } else if (message.action === 'stopPipeline') {
    if (globalThis.bulkygenPipeline) {
      globalThis.bulkygenPipeline.stop();
      ext.storage.local.set({ pipelineRunning: false }).catch(() => { });
      stopSwKeepAlive();
      disarmKeepAliveAlarm();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Pipeline module not loaded' });
    }
    return false;
  } else if (message.action === 'pauseGeneration') {
    isPaused = true;
    ext.storage.local.set({ isPaused: true }).catch(() => { });
  } else if (message.action === 'resumeGeneration') {
    isPaused = false;
    ext.storage.local.set({ isPaused: false }).catch(() => { });
  } else if (message.action === 'fetchImageAsBase64') {
    // Fetch cross-origin image from background (bypasses CORS)
    fetchImageAsBase64(message.imageUrl).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open for async response
  } else if (message.action === 'downloadZip') {
    createAndDownloadZipFromDb().then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open for async response
  } else if (message.action === 'regenerateItem') {
    regenerateSingleItem(message.itemId).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  } else if (message.action === 'saveImage') {
    // Save generated image data for ZIP download
    saveGeneratedImage(message.imageData, message.prompt, message.itemId).then(() => {
      sendResponse({ success: true });
    });
    return true;
  } else if (message.action === 'flowForceClick') {
    forceClickInPage(sender?.tab?.id).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ ok: false, error: error.message });
    });
    return true; // async response
  } else if (message.action === 'clearAllImages') {
    clearAllGeneratedImages().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  } else if (message.action === 'exportLogs') {
    // Return the serialised log buffer to any settings/popup page that asks
    try {
      const text = globalThis.bulkygenLogger?.exportText?.() || '';
      sendResponse({ text });
    } catch (e) {
      sendResponse({ text: '' });
    }
    return false;
  } else if (message.action === 'applyLogLevel') {
    // Dynamically change the running log level without extension reload
    try {
      if (globalThis.bulkygenLogger && message.level) {
        globalThis.bulkygenLogger.setLevel(message.level);
      }
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false });
    }
    return false;
  }
});

// Block here while the user has PAUSED generation, without ending the run or
// losing the queue position. Stop clears both isPaused and isRunning, so this
// also unblocks instantly on Stop.
async function waitWhilePaused() {
  while (isPaused && isRunning) {
    await sleep(200);
  }
}

// Per-run record of captured image bytes so the SAME image is never saved to
// two different queue slots (universal safety net across all providers).
const __runCapturedHashes = new Set();
function imageHash(d) { return d ? (d.length + '|' + d.slice(-128)) : ''; }
function isDuplicateCapture(imageData) {
  const h = imageHash(imageData);
  if (!h) return false;
  if (__runCapturedHashes.has(h)) return true;
  __runCapturedHashes.add(h);
  return false;
}

// --- Pushed-result registry -------------------------------------------------
// Lets the generation loop recover a finished result when the sendMessage
// response channel closes mid-generation (MV3), instead of regenerating.
const __resultWaiters = new Map(); // itemId -> resolver fn
const __resultBuffer = new Map();  // itemId -> { result, timer } (arrived early)

function __deliverPushedResult(itemId, result) {
  if (itemId == null) return;
  const waiter = __resultWaiters.get(itemId);
  if (waiter) {
    waiter(result);
    return;
  }
  // No waiter yet: buffer briefly so a waiter registered moments later can find it.
  const prev = __resultBuffer.get(itemId);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => __resultBuffer.delete(itemId), 30000);
  __resultBuffer.set(itemId, { result, timer });
}

function registerResultWaiter(itemId, timeoutMs) {
  let timer = null;
  let resolveFn = null;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
    const buffered = __resultBuffer.get(itemId);
    if (buffered) {
      if (buffered.timer) clearTimeout(buffered.timer);
      __resultBuffer.delete(itemId);
      resolve(buffered.result);
      return;
    }
    timer = setTimeout(() => { __resultWaiters.delete(itemId); resolve(null); }, timeoutMs);
    __resultWaiters.set(itemId, (r) => {
      if (timer) clearTimeout(timer);
      __resultWaiters.delete(itemId);
      resolve(r);
    });
  });
  return {
    promise,
    cancel() { if (timer) clearTimeout(timer); __resultWaiters.delete(itemId); }
  };
}

function isSupportedTabUrl(url) {
  if (!url) return false;
  return url.includes('/fx/tools/flow/project/') ||
         (url.includes('meta.ai') && url.includes('/media')) ||
         (url.includes('grok.com') && url.includes('/imagine')) ||
         url.includes('digen.ai') ||
         (url.includes('gentube.app') && url.includes('/create')) ||
         (url.includes('firefly.adobe.com') && url.includes('/generate'));
}

// If startGeneration() fails before it ever reaches the per-item generation
// loop (no supported tab found, page check failed, etc.), the pipeline was
// previously left hanging for the full 300s timeout with zero information —
// these early-exit branches only called notifyPopup(), which the pipeline
// doesn't listen to. This reports the failure directly so it fails fast.
async function _reportPipelineStartFailure(reason) {
  try {
    const data = await ext.storage.local.get(['queue']);
    const queue = data.queue || [];
    for (const item of queue) {
      if (item._pipelineRecordId && globalThis.bulkygenPipeline) {
        globalThis.bulkygenPipeline.deliverGenerationResult(item.id, { success: false, error: reason });
      }
    }
  } catch (e) { /* ignore */ }
}

async function startGeneration(resumeTabId) {
  if (loopActive) return; // a loop is already running in this worker
  loopActive = true;
  isRunning = true;
  if (resumeTabId == null) { isPaused = false; __runCapturedHashes.clear(); }
  await ext.storage.local.set({ isRunning: true, isPaused });
  startSwKeepAlive();
  armKeepAliveAlarm();
  try {
    let tabId = resumeTabId;

    if (tabId == null) {
      // 1. Try the currently active tab first
      const [activeTab] = await ext.tabs.query({ active: true, currentWindow: true });
      if (activeTab && isSupportedTabUrl(activeTab.url)) {
        tabId = activeTab.id;
      } else {
        // 2. Search ALL open tabs for any supported generator page
        const allTabs = await ext.tabs.query({});
        const supportedTab = allTabs.find(t => isSupportedTabUrl(t.url));
        if (supportedTab) {
          tabId = supportedTab.id;
          console.log(`BulkyGen: Using background tab ${tabId} (${supportedTab.url.slice(0, 60)}...)`);
        } else {
          // 3. No supported page open anywhere — report error and exit
          const msg = 'No supported generator page found. Please open one of:\n- Flow: https://labs.google/fx/tools/flow/project\n- Meta AI: https://www.meta.ai/media\n- Grok: https://grok.com/imagine\n- Digen: https://digen.ai/image\n- Gentube: https://www.gentube.app/create\n- Firefly: https://firefly.adobe.com/generate/image';
          console.warn('BulkyGen: startGeneration aborted — no supported tab found');
          notifyPopup('generationError', { message: msg });
          await _reportPipelineStartFailure('No supported generator page found');
          isRunning = false;
          loopActive = false;
          await ext.storage.local.set({ isRunning: false });
          return;
        }
      }
    }

    currentTabId = tabId;
    await ext.storage.local.set({ genTabId: tabId });
    // Hold the page's silent-audio keep-alive for the entire run so it stays
    // unthrottled in the background between every prompt / fetch / retry.
    try { ext.tabs.sendMessage(tabId, { action: 'bgKeepAlive', on: true }).catch(() => { }); } catch (e) { }
    let currentProvider = 'unknown';

    // Make sure the content script is loaded (no manual page reload needed).
    await ensureTabContentScript(currentTabId);

    // Verify we're on a supported page (works without `tabs` permission)
    // Retry a few times: right after ensureTabContentScript() resolves, the
    // content script may not have finished registering its message listener
    // yet (a common MV3 race — "Receiving end does not exist"). A single
    // attempt here was silently treated as "unsupported page" even when a
    // supported page was open the whole time.
    let checkRes = null;
    let checkErr = null;
    for (let i = 0; i < 4; i++) {
      try {
        const res = await ext.tabs.sendMessage(currentTabId, { action: 'checkPage' });
        if (res && res.isSupportedPage) {
          checkRes = res;
          break;
        }
        checkErr = new Error('Unsupported page');
      } catch (e) {
        checkErr = e;
      }
      await sleep(500);
    }

    if (!checkRes) {
      console.warn(`BulkyGen: startGeneration aborted — checkPage never succeeded (${checkErr?.message || 'unknown reason'})`);
      notifyPopup('generationError', {
        message: 'Please navigate to a supported page:\n- Flow: https://labs.google/fx/tools/flow/project\n- Digen: https://digen.ai/image\n- Gentube: https://www.gentube.app/create\n- Firefly: https://firefly.adobe.com/generate/image\n- Meta AI: https://www.meta.ai/media\n- Grok: https://x.com/i/grok'
      });
      await _reportPipelineStartFailure(`checkPage failed: ${checkErr?.message || 'unsupported page'}`);
      isRunning = false;
      loopActive = false;
      await ext.storage.local.set({ isRunning: false });
      return;
    }
    currentProvider = checkRes.provider || 'unknown';

    const data = await ext.storage.local.get(['queue', 'delay']);
    const queue = data.queue || [];
    const delay = (data.delay || 1) * 1000; // Faster default delay (1s)

    if (currentProvider === 'flow') {
      await runFlowSequentialGeneration(queue, delay);
    } else {
      // Generic provider loop (Digen, Gentube, Meta AI, Grok, ...).
      // Same guarantees as Flow: NEVER FAIL (infinite, immediate retry until media
      // is actually captured) and ZERO delay between prompts. Runs in the
      // background no matter which tab is focused (keep-alive + background-safe
      // waits live in the content script).
      const MAX_RETRIES = Infinity;   // never give up on a prompt
      const RETRY_BACKOFF_MS = 0;     // retry instantly
      const GENERIC_GAP_MS = 0;       // no spacing between successful prompts
      const isGrok = currentProvider === 'grok';

      for (let i = 0; i < queue.length && isRunning; i++) {
        if (queue[i].status === 'completed') continue;

        // Honor Pause without losing our place in the queue.
        await waitWhilePaused();
        if (!isRunning) break;

        // Mark current item as processing.
        queue[i].status = 'processing';
        await ext.storage.local.set({ queue, currentIndex: i });
        notifyPopup('updateQueue', { queue });

        let attempt = 0;
        let succeeded = false;
        let fatalDisconnect = false;

        while (attempt <= MAX_RETRIES && isRunning && !succeeded) {
          try {
            await ensureTabContentScript(currentTabId);

            // Ask the content script to generate for this prompt.
            // Register a fallback waiter FIRST: long generations can outlive the
            // sendMessage response channel in MV3. If the channel closes, we wait
            // for the content script's pushed result instead of regenerating.
            const __waiter = registerResultWaiter(queue[i].id, 300000);
            let response;
            try {
              response = await ext.tabs.sendMessage(currentTabId, {
                action: 'generateImage',
                prompt: queue[i].prompt,
                itemId: queue[i].id
              });
              __waiter.cancel();
            } catch (sendErr) {
              const smsg = (sendErr && sendErr.message) || String(sendErr);
              if (/message channel closed|asynchronous response|message port closed/i.test(smsg)) {
                console.log(`⏳ ${currentProvider}: response channel closed for prompt ${i + 1}; awaiting pushed result (no regeneration)...`);
                response = await __waiter.promise;
                if (!response) {
                  throw new Error('Generation result not received after the response channel closed');
                }
              } else {
                __waiter.cancel();
                throw sendErr;
              }
            }

            if (!response || !response.success) {
              throw new Error(response?.error || 'Generation failed');
            }

            // Save whatever media came back.
            let captured = false;
            if (response.multipleVideos && Array.isArray(response.multipleVideos) && response.multipleVideos.length) {
              // Meta AI: multiple videos per prompt.
              console.log(`\u{1F4F9} Saving ${response.multipleVideos.length} Meta AI videos...`);
              for (let videoIdx = 0; videoIdx < response.multipleVideos.length; videoIdx++) {
                const videoData = response.multipleVideos[videoIdx];
                try {
                  await saveGeneratedImage(
                    videoData.imageData,
                    `${queue[i].prompt} (Video ${videoIdx + 1}/${response.multipleVideos.length})`,
                    queue[i].id,
                    videoData.meta
                  );
                  captured = true;
                } catch (saveError) {
                  console.error(`Video ${videoIdx + 1} save error (continuing):`, saveError);
                }
              }
            } else if (response.imageData) {
              // Single image/video for the other providers. If it's a duplicate of
              // an image already captured for an earlier slot, fail so the loop
              // auto-retries and regenerates a fresh one for THIS slot.
              if (isDuplicateCapture(response.imageData)) {
                throw new Error('Only a duplicate of an earlier image was captured; regenerating for a fresh result');
              }
              await saveGeneratedImage(response.imageData, queue[i].prompt, queue[i].id, response.meta);
              captured = true;
            }

            // Nothing captured -> treat as failure so it auto-retries in place.
            if (!captured) {
              const why = response.meta && response.meta.captureError
                ? `capture failed: ${response.meta.captureError}`
                : 'no media captured';
              throw new Error(why);
            }

            // Success.
            queue[i].status = 'completed';
            await ext.storage.local.set({ queue });
            notifyPopup('updateQueue', { queue });
            succeeded = true;

            // Deliver result to pipeline if this item originated from autonomous mode
            if (queue[i]._pipelineRecordId && globalThis.bulkygenPipeline) {
              try {
                globalThis.bulkygenPipeline.deliverGenerationResult(queue[i].id, {
                  success: true,
                  imageData: response.imageData,
                  multipleImages: response.multipleVideos || null,
                  meta: response.meta
                });
              } catch (e) { /* ignore */ }
            }

            // For Grok: go back to the homepage so the next prompt is ready.
            if (response.needsNavigation && response.navigateTo) {
              console.log('\u{1F504} Grok: navigating to', response.navigateTo, 'for next generation...');
              try {
                await ext.tabs.update(currentTabId, { url: response.navigateTo });
                await waitForPageReady(currentTabId, 30);
              } catch (navErr) {
                console.error('Grok navigation error:', navErr);
              }
            }
          } catch (error) {
            console.error('Generation error:', error);

            // A dead content-script connection can't be retried on this tab as-is;
            // try one forced re-inject, otherwise stop the run.
            if (error.message && error.message.includes('Could not establish connection')) {
              try {
                await ensureTabContentScript(currentTabId, true);
                await sleep(500);
              } catch (reinjectErr) {
                fatalDisconnect = true;
                break;
              }
            }

            attempt++;
            console.log(`\u{1F501} ${currentProvider}: prompt ${i + 1} failed (${error.message}); retrying immediately (attempt ${attempt})...`);
            notifyPopup('generationError', {
              message: `Prompt ${i + 1} failed (${error.message.replace('CONTENT_MODERATED: ', '')}); auto-retrying...`
            });

            // Keep the slot marked processing while we retry in place.
            queue[i].status = 'processing';
            await ext.storage.local.set({ queue });
            notifyPopup('updateQueue', { queue });

            // For Grok: failures (moderation/timeout) need a return to the
            // homepage before the next attempt can work.
            if (isGrok) {
              try {
                await ext.tabs.update(currentTabId, { url: 'https://grok.com/imagine/' });
                await waitForPageReady(currentTabId, 30);
              } catch (navError) {
                console.error('Navigation error:', navError);
              }
            }

            if (RETRY_BACKOFF_MS > 0) await sleep(RETRY_BACKOFF_MS);
          }
        }

        await ext.storage.local.set({ queue });
        notifyPopup('updateQueue', { queue });

        if (fatalDisconnect) {
          notifyPopup('generationError', {
            message: 'Content script not loaded. Please refresh the current generator page and try again.'
          });
          isRunning = false;
          break;
        }

        // Move to the next prompt the instant this one's media is captured.
        const hasMorePending = queue.slice(i + 1).some(item => item.status !== 'completed');
        if (hasMorePending && isRunning && GENERIC_GAP_MS > 0) {
          await sleep(GENERIC_GAP_MS);
        }
      }
    }
    // Generation complete
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
    notifyPopup('generationComplete', {});

    // Show system notification
    if (ext.notifications) {
      ext.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'BulkyGen Complete',
        message: 'Bulk generation process finished.'
      });
    }
  } finally {
    loopActive = false;
    if (!isRunning) {
      stopSwKeepAlive();
      disarmKeepAliveAlarm();
      if (currentTabId != null) {
        try { ext.tabs.sendMessage(currentTabId, { action: 'bgKeepAlive', on: false }).catch(() => { }); } catch (e) { }
      }
    }
  }
}

async function runFlowSequentialGeneration(queue, delay) {
  // Inject prompts into the Flow project ONE BY ONE (line by line). For each
  // prompt we type it into the composer, click generate, and wait until the
  // image is actually captured. The INSTANT the image is fetched we move on to
  // the next prompt with zero added delay ("lightning fast").
  //
  // If a prompt fails (error, timeout, or no image captured) we AUTO-RETRY the
  // SAME queue slot a few times before giving up, so a transient failure self-
  // heals without losing its place in the queue.
  // NEVER FAIL: keep retrying the same prompt until it actually produces an
  // image. Retries fire IMMEDIATELY (no backoff). The only things that end the
  // loop are a successful capture or the user pressing Stop (isRunning = false).
  const MAX_RETRIES = Infinity;   // never give up on a prompt
  const RETRY_BACKOFF_MS = 0;     // retry instantly
  const FLOW_GAP_MS = 0;          // no spacing between successful prompts

  for (let i = 0; i < queue.length && isRunning; i++) {
    if (queue[i].status === 'completed') continue;

    // Honor Pause without losing our place in the queue.
    await waitWhilePaused();
    if (!isRunning) break;

    // Mark current line as processing
    queue[i].status = 'processing';
    await ext.storage.local.set({ queue, currentIndex: i });
    notifyPopup('updateQueue', { queue });

    let attempt = 0;
    let succeeded = false;
    let fatalDisconnect = false;

    while (attempt <= MAX_RETRIES && isRunning && !succeeded) {
      try {
        await ensureTabContentScript(currentTabId);

        let result;
        try {
          result = await ext.tabs.sendMessage(currentTabId, {
            action: 'flowSubmitPrompt',
            prompt: queue[i].prompt,
            itemId: queue[i].id
          });
        } catch (sendErr) {
          // Content script unreachable -> force re-inject and retry once.
          await ensureTabContentScript(currentTabId, true);
          await sleep(400);
          result = await ext.tabs.sendMessage(currentTabId, {
            action: 'flowSubmitPrompt',
            prompt: queue[i].prompt,
            itemId: queue[i].id
          });
        }

        // Collect captured images (Flow x2 / x4 produce multiple per prompt).
        const flowImgs = Array.isArray(result?.multipleImages) && result.multipleImages.length
          ? result.multipleImages
          : (result?.imageData ? [{ imageData: result.imageData, meta: result.meta }] : []);

        // Treat "no image captured" the same as a failure so it auto-retries.
        if (!result?.success || flowImgs.length === 0) {
          throw new Error(result?.error || 'No image captured');
        }

        // Drop any image already captured for an earlier slot (Flow can re-serve
        // the prior preview). If NONE are new, fail so we regenerate a genuinely
        // fresh image for THIS slot.
        const freshFlowImgs = flowImgs.filter(fi => !isDuplicateCapture(fi.imageData));
        if (freshFlowImgs.length === 0) {
          throw new Error('Only a duplicate of an earlier image was captured; regenerating for a fresh result');
        }

        for (let n = 0; n < freshFlowImgs.length; n++) {
          try {
            const label = freshFlowImgs.length > 1
              ? `${queue[i].prompt} (${n + 1}/${freshFlowImgs.length})`
              : queue[i].prompt;
            await saveGeneratedImage(freshFlowImgs[n].imageData, label, queue[i].id, freshFlowImgs[n].meta);
          } catch (saveError) {
            console.error('Flow image save error (continuing):', saveError);
          }
        }

        queue[i].status = 'completed';
        succeeded = true;

        // Deliver result to pipeline if this item originated from autonomous mode
        if (queue[i]._pipelineRecordId && globalThis.bulkygenPipeline) {
          try {
            globalThis.bulkygenPipeline.deliverGenerationResult(queue[i].id, {
              success: true,
              imageData: freshFlowImgs[0]?.imageData,
              multipleImages: freshFlowImgs,
              meta: freshFlowImgs[0]?.meta
            });
          } catch (e) { /* ignore */ }
        }
      } catch (err) {
        // A dead content-script connection can't be fixed by retrying the same
        // tab, so stop the whole run and ask for a refresh.
        if (err.message && err.message.includes('Could not establish connection')) {
          fatalDisconnect = true;
          break;
        }

        attempt++;
        if (attempt > MAX_RETRIES) {
          queue[i].status = 'error';
          notifyPopup('generationError', {
            message: `Flow prompt ${i + 1} failed after ${MAX_RETRIES + 1} tries: ${err.message}`
          });
        } else {
          console.log(`\u{1F501} Flow: prompt ${i + 1} failed (${err.message}); auto-retrying in place immediately (attempt ${attempt})...`);
          // Keep the slot marked as processing while we retry it in place.
          queue[i].status = 'processing';
          await ext.storage.local.set({ queue });
          notifyPopup('updateQueue', { queue });
          await sleep(RETRY_BACKOFF_MS);
        }
      }
    }

    await ext.storage.local.set({ queue });
    notifyPopup('updateQueue', { queue });

    if (fatalDisconnect) {
      notifyPopup('generationError', {
        message: 'Content script not loaded. Please refresh the Flow project page and try again.'
      });
      isRunning = false;
      break;
    }

    // Move to the next prompt the instant this one's image is captured.
    const hasMorePending = queue.slice(i + 1).some(item => item.status !== 'completed');
    if (hasMorePending && isRunning && FLOW_GAP_MS > 0) {
      await sleep(FLOW_GAP_MS);
    }
  }
}
async function regenerateSingleItem(itemId) {
  if (!itemId) return;
  if (isRunning) {
    throw new Error('Generation is already running');
  }

  isRunning = true;
  await ext.storage.local.set({ isRunning: true });

  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;
  let currentProvider = 'unknown';

  try {
    const res = await ext.tabs.sendMessage(currentTabId, { action: 'checkPage' });
    if (!res || !res.isSupportedPage) throw new Error('Unsupported page');
    currentProvider = res.provider || 'unknown';
  } catch {
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
    throw new Error('Please navigate to a supported page (Flow, Digen, Meta AI, or Grok) before regenerating.');
  }

  const data = await ext.storage.local.get(['queue', 'delay']);
  const queue = data.queue || [];
  const idx = queue.findIndex(q => q.id === itemId);
  if (idx === -1) {
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
    return;
  }

  // Tab activation removed to support background execution
  // Content script handles keep-alive

  queue[idx].status = 'processing';
  await ext.storage.local.set({ queue, currentIndex: idx });
  notifyPopup('updateQueue', { queue });

  try {
    await ensureTabContentScript(currentTabId);
    const response = await ext.tabs.sendMessage(currentTabId, {
      action: currentProvider === 'flow' ? 'flowSubmitPrompt' : 'generateImage',
      prompt: queue[idx].prompt,
      itemId: queue[idx].id
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Generation failed');
    }

    if (currentProvider !== 'flow') {
      // Save image/video data if provided
      // For Meta AI: handle multiple videos
      if (response.multipleVideos && Array.isArray(response.multipleVideos)) {
        console.log(`📹 Saving ${response.multipleVideos.length} Meta AI videos...`);
        for (let videoIdx = 0; videoIdx < response.multipleVideos.length; videoIdx++) {
          const videoData = response.multipleVideos[videoIdx];
          try {
            await saveGeneratedImage(
              videoData.imageData,
              `${queue[idx].prompt} (Video ${videoIdx + 1}/${response.multipleVideos.length})`,
              queue[idx].id,
              videoData.meta
            );
          } catch (saveError) {
            console.error(`Video ${videoIdx + 1} save error (continuing):`, saveError);
          }
        }
      } else if (response.imageData) {
        // Single image/video for other providers
        try {
          await saveGeneratedImage(response.imageData, queue[idx].prompt, queue[idx].id, response.meta);
        } catch (saveError) {
          console.error('Image save error (continuing):', saveError);
          notifyPopup('imageSaveError', {
            message: saveError?.message || 'Failed to save image data (continuing)'
          });
        }
      }
    } else {
      // Flow: save ALL captured images (x2 / x4 produce multiple)
      const flowImgs = Array.isArray(response.multipleImages) && response.multipleImages.length
        ? response.multipleImages
        : (response.imageData ? [{ imageData: response.imageData, meta: response.meta }] : []);
      for (let n = 0; n < flowImgs.length; n++) {
        try {
          const label = flowImgs.length > 1
            ? `${queue[idx].prompt} (${n + 1}/${flowImgs.length})`
            : queue[idx].prompt;
          await saveGeneratedImage(flowImgs[n].imageData, label, queue[idx].id, flowImgs[n].meta);
        } catch (saveError) {
          console.error('Flow image save error (continuing):', saveError);
        }
      }
    }

    queue[idx].status = 'completed';
    await ext.storage.local.set({ queue });
    notifyPopup('updateQueue', { queue });
  } catch (error) {
    queue[idx].status = 'error';
    await ext.storage.local.set({ queue });
    notifyPopup('updateQueue', { queue });
    throw error;
  } finally {
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
  }
}

// Inject a MAIN-world script that invokes the marked button's real React
// Make sure the content script is present in the tab before we message it.
// Prevents "Receiving end does not exist" when the page was open before the
// extension installed, or after a navigation. Idempotent: it probes a marker
// and only injects when the script is actually missing (or force=true).
// Wait until the content script on a (possibly just-navigated) tab is ready.
// Used after Grok navigation so the next prompt only fires on a live page.
async function waitForPageReady(tabId, maxAttempts = 30) {
  let attempts = 0;
  await sleep(1000);
  while (attempts < maxAttempts) {
    try {
      const res = await ext.tabs.sendMessage(tabId, { action: 'checkPage' });
      if (res && res.isSupportedPage) {
        await sleep(1500); // small settle so the UI is interactive
        return true;
      }
    } catch (e) { /* content script not ready yet */ }
    await sleep(1000);
    attempts++;
  }
  console.log('\u26A0\uFE0F Page load timeout; continuing anyway...');
  return false;
}

async function ensureTabContentScript(tabId, force) {
  if (tabId == null) return false;
  const scripting = (globalThis.chrome && globalThis.chrome.scripting) ||
    (globalThis.browser && globalThis.browser.scripting);
  if (!scripting) return false;
  try {
    if (!force) {
      try {
        const probe = await scripting.executeScript({
          target: { tabId },
          func: () => !!window.__BULKYGEN_CS_LOADED__
        });
        if (probe && probe[0] && probe[0].result) return true;
      } catch (_probeErr) { /* proceed to inject */ }
    }
    await scripting.executeScript({ target: { tabId }, files: ['ext.js', 'content.js'] });
    await sleep(300);
    return true;
  } catch (e) {
    console.warn('ensureTabContentScript failed:', e);
    return false;
  }
}

// onClick handler. Requires the "scripting" permission + host permission.
async function forceClickInPage(tabId) {
  if (tabId == null) return { ok: false, error: 'no tab id' };
  const scripting = (globalThis.chrome && globalThis.chrome.scripting) ||
    (globalThis.browser && globalThis.browser.scripting);
  if (!scripting) return { ok: false, error: 'scripting API unavailable' };
  try {
    const results = await scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: mainWorldForceClick
    });
    const out = results && results[0] ? results[0].result : null;
    console.log('BulkyGen Flow: force-click result', out);
    return { ok: true, result: out };
  } catch (e) {
    console.error('forceClickInPage failed:', e);
    return { ok: false, error: e.message };
  }
}

// Runs in the PAGE main world. Finds the button marked by the content script,
// walks up to its React props, and calls the real onClick handler directly.
function mainWorldForceClick() {
  const out = { found: false, calledOnClick: false, dispatched: false, handlerDepth: -1, info: '' };
  try {
    const findBtn = () => {
      // 1) Button the content script marked
      let m = document.querySelector('[data-bulkygen-submit="1"]');
      if (m) return m;
      // 2) The exact "arrow_forward" / Create icon button
      const syms = Array.from(document.querySelectorAll('i, span'));
      for (const s of syms) {
        if ((s.textContent || '').trim().toLowerCase() === 'arrow_forward') {
          const btn = s.closest('button, [role="button"]');
          if (btn) return btn;
        }
      }
      // 3) Any button whose markup contains arrow_forward
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of btns) { if (/arrow_forward/.test(btn.innerHTML || '')) return btn; }
      return null;
    };
    const el = findBtn();
    if (!el) { out.info = 'target not found'; return out; }
    out.found = true;
    out.aria = el.getAttribute ? el.getAttribute('aria-disabled') : null;

    const makeEvent = (type, node) => ({
      type, bubbles: true, cancelable: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { }, stopImmediatePropagation() { },
      isPropagationStopped: () => false,
      isDefaultPrevented() { return this.defaultPrevented; },
      persist() { }, nativeEvent: { isTrusted: true, type, bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1, view: window, clientX: 0, clientY: 0, screenX: 0, screenY: 0, pageX: 0, pageY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0.5, target: node, currentTarget: node, preventDefault() { }, stopPropagation() { }, stopImmediatePropagation() { }, composedPath: () => [node] }, currentTarget: node, target: node,
      button: 0, buttons: 1, detail: 1, view: window, isTrusted: true,
      clientX: 0, clientY: 0, pointerId: 1, pointerType: 'mouse'
    });

    // Walk up from the button to find React props carrying onClick / onPointerDown
    let node = el, depth = 0, handler = null, handlerNode = null;
    while (node && depth < 8) {
      let props = null;
      const pk = Object.keys(node).find(k => k.indexOf('__reactProps$') === 0);
      if (pk && node[pk]) props = node[pk];
      if (!props) {
        const fk = Object.keys(node).find(k => k.indexOf('__reactFiber$') === 0);
        if (fk && node[fk] && node[fk].memoizedProps) props = node[fk].memoizedProps;
      }
      if (props && (typeof props.onClick === 'function' || typeof props.onPointerDown === 'function')) {
        handler = props; handlerNode = node; out.handlerDepth = depth; break;
      }
      node = node.parentElement; depth++;
    }

    if (handler) {
      try {
        if (typeof handler.onPointerDown === 'function') handler.onPointerDown(makeEvent('pointerdown', handlerNode));
        if (typeof handler.onMouseDown === 'function') handler.onMouseDown(makeEvent('mousedown', handlerNode));
        if (typeof handler.onPointerUp === 'function') handler.onPointerUp(makeEvent('pointerup', handlerNode));
        if (typeof handler.onMouseUp === 'function') handler.onMouseUp(makeEvent('mouseup', handlerNode));
        if (typeof handler.onClick === 'function') { handler.onClick(makeEvent('click', handlerNode)); out.calledOnClick = true; }
      } catch (e) { out.info += ' handler err: ' + e.message; }
    } else {
      out.info += ' no react onClick found;';
    }

    // Genuine native click in the main world as a backup
    try {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
      const p = { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...p, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new MouseEvent('click', base));
      el.click();
      out.dispatched = true;
    } catch (e) { out.info += ' dispatch err: ' + e.message; }
  } catch (e) {
    out.info += ' fatal: ' + e.message;
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch cross-origin image as base64 (background script can bypass CORS)
async function fetchImageAsBase64(imageUrl) {
  try {
    // Try with credentials first (for authenticated resources like Grok videos)
    let response = await fetch(imageUrl, {
      mode: 'cors',
      credentials: 'include'
    });

    // If 403 with credentials, try without (some CDNs reject credentialed requests)
    if (response.status === 403) {
      console.log('Retrying fetch without credentials...');
      response = await fetch(imageUrl, {
        mode: 'cors',
        credentials: 'omit'
      });
    }

    // If still failing, try with no-cors (opaque response, but might work)
    if (!response.ok && response.status === 403) {
      console.log('Retrying with different headers...');
      response = await fetch(imageUrl, {
        mode: 'no-cors'
      });
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

// ── Auto-start autonomous pipeline on boot ──────────────────────────────────
// Also restores persisted log entries and applies the user's log level setting.
(async () => {
  try {
    // Phase 15: restore persisted log entries into in-memory buffer
    if (globalThis.bulkygenLogger) {
      await globalThis.bulkygenLogger.restore();
    }

    if (globalThis.bulkygenSettings) {
      await globalThis.bulkygenSettings.load();
      const settings = await globalThis.bulkygenSettings.get();

      // Phase 18: apply debug log level from user settings
      if (globalThis.bulkygenLogger && settings.logLevel) {
        globalThis.bulkygenLogger.setLevel(settings.debugMode ? 'verbose' : settings.logLevel);
        globalThis.bulkygenLogger.info('Background', `Log level set to: ${settings.debugMode ? 'verbose' : settings.logLevel}`);
      }

      // Auto-start pipeline if autonomousMode is enabled
      if (settings && settings.autonomousMode) {
        if (globalThis.bulkygenPipeline && !globalThis.bulkygenPipeline.isRunning) {
          console.log('BulkyGen: Auto-starting autonomous pipeline on boot');
          globalThis.bulkygenPipeline.start();
        }
      }
    }
  } catch (e) {
    console.warn('BulkyGen: Auto-start pipeline check failed:', e);
  }
})();