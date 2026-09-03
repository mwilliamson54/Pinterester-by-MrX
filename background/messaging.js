// Part of background.js, split out for readability. Runs in the same
// service-worker global scope as background.js and the other
// background/*.js files (loaded via importScripts — NOT ES modules),
// so everything here shares state (isRunning, isPaused, etc.) with them
// exactly as it did when this was all one file.



ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startGeneration') {
    sendResponse(tryStartGeneration());
    return false;
  } else if (message.action === 'stopGeneration') {
    isRunning = false;
    isPaused = false;
    loopActive = false;
    loopActiveSince = null;
    markLoopProgress('stopped');
    ext.storage.local.set({ isPaused: false, isRunning: false }).catch(() => { });
    stopSwKeepAlive();
    disarmKeepAliveAlarm();
    if (currentTabId != null) {
      try { ext.tabs.sendMessage(currentTabId, { action: 'bgKeepAlive', on: false }).catch(() => { }); } catch (e) { }
    }
    return false;
  } else if (message.action === 'abortGeneration') {
    abortGenerationLoop(message.reason || 'abortGeneration message');
    sendResponse({ aborted: true });
    return false;
  } else if (message.action === 'clientLog') {
    // Diagnostics pushed from content.js (the Flow/provider tab) — see
    // logToExtension() above for why this bridge exists.
    logToExtension(message.level || 'info', message.tag || 'ContentScript', message.message || '');
    return false;
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
  } else if (message.action === 'checkGenerationAlive') {
    // Includes phase/stall info so a hung loop (loopActive=true but no progress)
    // fails fast instead of burning the full 300s pipeline timeout.
    sendResponse(getGenerationStatus());
    return false;
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