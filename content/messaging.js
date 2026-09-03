// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;



// Note: we intentionally do NOT scan the entire Whisk UI on page load.
// The page is heavy and changes frequently; aggressive polling can slow down
// Whisk boot. We only run UI detection when the user starts generation.

// Listen for messages from background
// Guard against duplicate listeners when ensureTabContentScript re-injects this file.
if (!window.__BULKYGEN_CS_LISTENER__) {
window.__BULKYGEN_CS_LISTENER__ = true;
NS.ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'NS.togglePanel') {
    NS.togglePanel();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'fetchUrlAsBase64') {
    // Runs inside the Flow tab so it can read blob: object URLs Flow created
    // (only resolvable in the page that made them) and reuse the page's own
    // cookies/CORS context -- the background service worker can't do either.
    (async () => {
      try {
        const response = await fetch(message.url, { mode: 'cors', credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (blob.size < 100) throw new Error('Response too small, likely failed');
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
          reader.readAsDataURL(blob);
        });
        sendResponse({ success: true, dataUrl });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true; // async response
  }

  if (message.action === 'NS.generateImage') {
    const __genItemId = message.itemId;
    const __pushResult = (result) => {
      // Push the result back independently of the response channel. Long
      // generations can outlive the sendMessage channel (MV3), so this push is
      // the reliable delivery path; the background waits for it if the channel
      // closes, instead of wasting a regeneration.
      try {
        (globalThis.chrome || NS.ext).runtime.sendMessage({
          action: 'generationResult', itemId: __genItemId, result
        });
      } catch (e) { /* ignore */ }
    };
    NS.generateImage(message.prompt, __genItemId)
      .then(result => {
        // For Grok: Include flag to tell background script to navigate and wait
        if (result.success && NS.PROVIDER === 'grok') {
          result.needsNavigation = true;
          result.navigateTo = 'https://grok.com/imagine/';
        }
        __pushResult(result);
        try { sendResponse(result); } catch (e) { /* channel may be closed */ }
      })
      .catch(error => {
        __pushResult({ success: false, error: error.message });
        try { sendResponse({ success: false, error: error.message }); } catch (e) { /* ignore */ }
      });
    return true; // Keep channel open for async response
  }

  if (message.action === 'flowSubmitPrompt') {
    NS.clientLog('info', 'Flow', `Received flowSubmitPrompt message (itemId=${message.itemId}).`);
    const __flowItemId = message.itemId;
    const __pushFlowResult = (result) => {
      // Same reliable delivery path used for NS.generateImage: push the result
      // independently of the sendMessage response channel. Flow generations
      // (NS.waitForFlowResults can run up to 120s, plus injection/click time) can
      // easily outlive that channel in MV3 — without this push, a result that
      // arrives after the channel closed was silently lost, so the background
      // loop assumed failure and resubmitted the SAME prompt into Flow again,
      // which is why generation appeared to loop forever and always hit the
      // 300s pipeline timeout.
      try {
        (globalThis.chrome || NS.ext).runtime.sendMessage({
          action: 'generationResult', itemId: __flowItemId, result
        });
      } catch (e) { /* ignore */ }
    };
    NS.submitFlowPrompt(message.prompt, message.itemId, message.aspectRatio)
      .then(result => {
        __pushFlowResult(result);
        try { sendResponse(result); } catch (e) { /* channel may be closed */ }
      })
      .catch(error => {
        const result = { success: false, error: error.message };
        __pushFlowResult(result);
        try { sendResponse(result); } catch (e) { /* ignore */ }
      });
    return true;
  }

  if (message.action === 'bgKeepAlive') {
    // Background asks us to hold the silent-audio keep-alive for the WHOLE run
    // (not just per prompt), so the tab never re-throttles between steps.
    if (message.on) {
      if (!NS.bgPersistKeepAlive) {
        NS.bgPersistKeepAlive = true;
        NS.__capturedResultKeys.clear();
        NS.__capturedResultSrcs.clear();
        NS.__capturedDataUrls.clear();
        NS.ensureKeepAlive();
      }
    } else if (NS.bgPersistKeepAlive) {
      NS.bgPersistKeepAlive = false; NS.releaseKeepAlive();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'checkPage') {
    sendResponse({ provider: NS.PROVIDER, isSupportedPage: NS.PROVIDER !== 'unknown' });
    return false;
  }
  return false;
});
}
})();
