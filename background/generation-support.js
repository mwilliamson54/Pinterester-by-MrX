// Part of background.js, split out for readability. Runs in the same
// service-worker global scope as background.js and the other
// background/*.js files (loaded via importScripts — NOT ES modules),
// so everything here shares state (isRunning, isPaused, etc.) with them
// exactly as it did when this was all one file.



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
         url.includes('flow.google.com/project/') ||
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