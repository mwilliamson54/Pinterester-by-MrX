// Part of background.js, split out for readability. Runs in the same
// service-worker global scope as background.js and the other
// background/*.js files (loaded via importScripts — NOT ES modules),
// so everything here shares state (isRunning, isPaused, etc.) with them
// exactly as it did when this was all one file.



let isRunning = false;
let isPaused = false;
let currentTabId = null;
let loopActive = false; // true while a generation loop runs in THIS worker instance
let loopActiveSince = null; // timestamp loopActive last flipped true — lets us detect a stuck/orphaned loop
let loopPhase = 'idle'; // coarse progress marker for pipeline heartbeat / stall detection
let loopProgressAt = 0; // Date.now() of last markLoopProgress()

// ── Generation run identity ─────────────────────────────────────────────────
// isRunning/loopActive are booleans shared by the WHOLE worker, not scoped to
// one particular run. That used to be enough to gate a NEW run from starting,
// but it could not stop an OLD run's in-flight promise chain: that chain only
// re-checks `isRunning` between awaits, and a fast stop+restart flips
// isRunning back to true before the old chain's current await resolves — so
// the "stopped" run just keeps going, now indistinguishable from the new run.
// Two loops then send flowSubmitPrompt to the SAME tab at the same time,
// fighting over the composer/generate button (this is what caused prompts to
// be resubmitted endlessly and images to never get captured/downloaded).
//
// __genRunSeq is a monotonically increasing token. Every time a run starts
// OR is forcibly invalidated (stop, stale/stalled recovery), the token is
// bumped. Each run captures its own token when it starts and must re-check
// it (not just isRunning) at every checkpoint — if the token has moved on,
// this run is stale and must stop touching the tab immediately, regardless
// of what isRunning currently says.
let __genRunSeq = 0;

/** Bump the run token, invalidating whatever run (if any) currently holds it. */
function invalidateCurrentGenerationRun() {
  return ++__genRunSeq;
}

/** Claim a fresh token for a NEW run that is about to start. */
function beginGenerationRun() {
  return ++__genRunSeq;
}

/** True if `token` still belongs to the current, non-superseded run. */
function isCurrentGenerationRun(token) {
  return token === __genRunSeq;
}

function markLoopProgress(phase) {
  loopPhase = phase || loopPhase;
  loopProgressAt = Date.now();
}

function getGenerationStatus() {
  return {
    alive: !!loopActive,
    phase: loopPhase,
    lastProgressAt: loopProgressAt || null,
    loopActiveSince: loopActiveSince || null,
    stalledMs: loopProgressAt ? (Date.now() - loopProgressAt) : null
  };
}

/** Force-stop a hung generation loop so the next pipeline record can start. */
function abortGenerationLoop(reason) {
  const msg = reason || 'unspecified';
  logToExtension('warn', 'Background', `Aborting generation loop (phase=${loopPhase}): ${msg}`);
  // Invalidate the run token FIRST. This is what actually makes the old
  // loop stop touching the tab — flipping isRunning alone was not enough,
  // because a restart could flip it back to true before the old loop's
  // current await resolved (see the __genRunSeq comment above).
  invalidateCurrentGenerationRun();
  isRunning = false;
  isPaused = false;
  loopActive = false;
  loopActiveSince = null;
  markLoopProgress('aborted');
  try { ext.storage.local.set({ isRunning: false, isPaused: false }).catch(() => { }); } catch (e) { /* ignore */ }
  if (currentTabId != null) {
    try { ext.tabs.sendMessage(currentTabId, { action: 'bgKeepAlive', on: false }).catch(() => { }); } catch (e) { /* ignore */ }
  }
}

/**
 * Race a promise against a timeout. Used to bound chrome.scripting.executeScript
 * and tabs.sendMessage calls that can hang indefinitely with zero logs.
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label || 'operation'} timed out after ${Math.round(ms / 1000)}s`));
      }, ms);
    })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Shared entry point for starting generation (message handler + in-process pipeline).
 * Avoids chrome.runtime.sendMessage self-calls from the service worker, which are
 * unreliable and were a source of silent null acks / lost starts.
 */
function tryStartGeneration(resumeTabId) {
  const STALE_MS = 6 * 60 * 1000;
  const STALL_MS = 90 * 1000; // no progress marks for 90s ⇒ orphaned even if loopActive
  const stalled = loopActive && loopProgressAt && (Date.now() - loopProgressAt > STALL_MS);
  const isStale = loopActive && loopActiveSince && (Date.now() - loopActiveSince > STALE_MS);
  if (loopActive && !isStale && !stalled) {
    logToExtension('warn', 'Background', 'startGeneration rejected — a generation loop is already active in this worker (loopActive=true).');
    return { started: false, reason: 'loopActive', status: getGenerationStatus() };
  }
  if (isStale || stalled) {
    logToExtension('warn', 'Background',
      `startGeneration: loopActive was stuck (phase=${loopPhase}, age=${Math.round((Date.now() - (loopActiveSince || Date.now())) / 1000)}s, stalledMs=${loopProgressAt ? Date.now() - loopProgressAt : 'n/a'}) — treating as orphaned and recovering.`);
    // Same reasoning as abortGenerationLoop(): bump the token so the
    // orphaned run (if it's still technically alive somewhere) can never
    // again be mistaken for "the current run" once a new one starts.
    invalidateCurrentGenerationRun();
    isRunning = false;
    loopActive = false;
    loopActiveSince = null;
    markLoopProgress('recovered');
  }
  startGeneration(resumeTabId).catch((e) => {
    logToExtension('error', 'Background', `startGeneration error: ${e?.message || e}`);
    console.error('startGeneration error:', e);
  });
  return { started: true, status: getGenerationStatus() };
}

// In-process API for modules/pipeline.js (same SW — no self-sendMessage needed).
globalThis.bulkygenGeneration = {
  tryStart: tryStartGeneration,
  abort: abortGenerationLoop,
  getStatus: getGenerationStatus,
  markProgress: markLoopProgress,
  beginRun: beginGenerationRun,
  isCurrentRun: isCurrentGenerationRun
};

// When startGeneration() bails out early (no supported tab, checkPage never
// succeeded, etc.) it previously just returned — leaving the pipeline's
// _awaitGenerationResult() with no idea anything went wrong. It would sit
// waiting the full 300s for a result that was never coming, and the REAL
// reason (visible only via console.warn in the service worker's own
// inspector) never reached the log the user actually looks at. This reads
// whatever's currently queued and fails it immediately with the real reason,
// so the pipeline retries right away instead of burning a silent 5 minutes.
async function _failQueuedItems(reason) {
  try {
    const data = await ext.storage.local.get(['queue']);
    const queue = data.queue || [];
    for (const item of queue) {
      if (item && item.id && item.status !== 'completed') {
        try {
          globalThis.bulkygenPipeline?.deliverGenerationResult(item.id, { success: false, error: reason });
        } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* non-fatal */ }
}

// Route a message into the exportable extension log (bulkygenLogger) AND the
// service worker console. Content scripts (content.js) run in the page's own
// JS context, so their console.log() output only ever shows up in that TAB's
// DevTools console — never in the service worker inspector, and never in the
// log the settings page exports. That gap is why Flow failures (e.g. "could
// not find the prompt box") were invisible: the extension just looked like it
// silently did nothing for 300s. Content scripts now report through the
// 'clientLog' message action below, which funnels into this same helper.
function logToExtension(level, tag, message) {
  try {
    const logger = globalThis.bulkygenLogger;
    if (logger && typeof logger[level] === 'function') {
      logger[level](tag, message);
      return;
    }
  } catch (e) { /* fall through to console */ }
  const fn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
  fn(`[BulkyGen][${tag}] ${message}`);
}