// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;



// Persistent, ref-counted keep-alive so the silent audio plays continuously
// for the WHOLE run (including the gaps between prompts) instead of being torn
// down and recreated each prompt. A lingering stop keeps it alive across short
// gaps so the tab never drops off the unthrottled list mid-queue.
// Cross-prompt record of results already captured this run, so the SAME image
// is never returned for two different queue slots (fixes duplicate thumbnails
// where every slot showed the first prompt\'s image).
const __capturedResultKeys = new Set();
const __capturedResultSrcs = new Set();
const __capturedDataUrls = new Set();
let __kaStop = null;
NS.bgPersistKeepAlive = false;
let __kaRefs = 0;
let __kaLingerTimer = null;
// The itemId of whatever generation is currently in flight in this content
// script context. Set to null when idle. Used by the unload handler below to
// send a failure signal to the background when this context is torn down while
// a generation is still running (e.g. Flow SPA navigates away mid-generation),
// so the pipeline fails fast instead of waiting 300 seconds.
NS.activeGenerationItemId = null;

// ── Generation exclusivity lock ───────────────────────────────────────────
// Guarantees at most one prompt is ever mid-flight (submitted, generating,
// or being captured/downloaded) in this tab at a time. Normally the
// background loop already waits for one prompt to fully finish before
// sending the next, but this lock makes that a hard guarantee at the point
// where prompts actually reach Flow/the page, regardless of what triggers
// the call (a duplicate message, a stray manual action, anything). Any
// overlapping call queues behind whatever generation is already running and
// only starts once that one has completely finished -- success or failure.
let __generationChain = Promise.resolve();
function runExclusiveGeneration(taskFn) {
  const started = __generationChain.then(taskFn, taskFn);
  // Keep the chain alive for the next caller regardless of outcome, without
  // letting one failure reject the chain for everyone after it.
  __generationChain = started.then(() => {}, () => {});
  return started;
}

// Flow virtualizes its project grid. Some old tiles are not in the DOM at a
// prompt's initial snapshot and can appear only because the user scrolls while
// a new generation is running. Keep a long-lived tile ledger from page load and
// mark tiles mounted near a GENUINE user scroll as untrusted for the active
// run. It is safer to retry than to silently assign an earlier prompt's
// artwork.
const __flowKnownTileIds = new Set();
const __flowScrollMountedTileIds = new Map();
let __flowTileTrackerInstalled = false;
let __flowLastUserScrollAt = 0;
const FLOW_SCROLL_GUARD_MS = 2500;

// ── Distinguishing a real user scroll from a programmatic one ─────────────
// A 'scroll' event alone does NOT mean the user did anything -- it fires
// identically for scrollIntoView() calls, regardless of who triggers them.
// Two sources of *our own* programmatic scrolling were already accounted
// for (flow-dom.js's scrollIntoView() on the composer and the generate
// button, suppressed below via markFlowProgrammaticScroll()). But logs
// showed tiles still being falsely rejected as "scroll-mounted" many
// seconds into a run, well outside either of those windows -- which points
// to a THIRD, uncontrollable source: Flow's own UI most likely auto-scrolls
// its results grid to reveal each newly-generated tile as it appears. That
// is a completely normal "scroll the new item into view" UI behavior, but
// it means a 'scroll' event fires at almost the exact moment the genuinely
// new tile mounts, on essentially every generation -- which is why this was
// closer to "always fails" than "sometimes".
//
// The fix: don't trust 'scroll' events at all as a signal of user intent.
// Instead, require recent evidence of an actual physical input gesture
// (mouse wheel, touch, or a scroll-relevant key) immediately before the
// scroll. Programmatic scrolling -- ours or Flow's -- never fires wheel/
// touch/keydown first; real user-driven scrolling always does. This makes
// the guard robust regardless of who or what triggers a given scroll.
let __flowLastPhysicalScrollInputAt = 0;
const FLOW_PHYSICAL_INPUT_WINDOW_MS = 500;
const FLOW_SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ']);

// Kept as a secondary, redundant safety net for our own two known
// scrollIntoView() call sites (see flow-dom.js) -- harmless now that the
// physical-input gate above is the primary defense, but cheap to keep.
let __flowSuppressScrollGuardUntil = 0;
function markFlowProgrammaticScroll(durationMs = 800) {
  __flowSuppressScrollGuardUntil = Date.now() + durationMs;
}

function rememberFlowTileIds(root) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
  const add = (img) => {
    const id = img?.getAttribute?.('data-media-id');
    if (!id) return;
    __flowKnownTileIds.add(id);
    if (Date.now() - __flowLastUserScrollAt <= FLOW_SCROLL_GUARD_MS) {
      __flowScrollMountedTileIds.set(id, Date.now());
    }
  };
  if (root.matches?.('img[data-media-id]')) add(root);
  root.querySelectorAll?.('img[data-media-id]').forEach(add);
}

function ensureFlowTileIdentityTracker() {
  if (__flowTileTrackerInstalled || NS.PROVIDER !== 'flow') return;
  __flowTileTrackerInstalled = true;
  document.querySelectorAll('img[data-media-id]').forEach(img => {
    const id = img.getAttribute('data-media-id');
    if (id) __flowKnownTileIds.add(id);
  });
  const markPhysicalInput = () => { __flowLastPhysicalScrollInputAt = Date.now(); };
  window.addEventListener('wheel', markPhysicalInput, { capture: true, passive: true });
  window.addEventListener('touchstart', markPhysicalInput, { capture: true, passive: true });
  window.addEventListener('touchmove', markPhysicalInput, { capture: true, passive: true });
  window.addEventListener('keydown', (e) => {
    if (FLOW_SCROLL_KEYS.has(e.key)) markPhysicalInput();
  }, true);
  window.addEventListener('scroll', () => {
    if (Date.now() < __flowSuppressScrollGuardUntil) return; // our own scrollIntoView(), not the user
    if (Date.now() - __flowLastPhysicalScrollInputAt > FLOW_PHYSICAL_INPUT_WINDOW_MS) return; // no wheel/touch/key just before this -- not user-driven
    __flowLastUserScrollAt = Date.now();
  }, true);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      record.addedNodes.forEach(node => rememberFlowTileIds(node));
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function createFlowRunIdentity(beforeTileIds) {
  ensureFlowTileIdentityTracker();
  return {
    beforeTileIds,
    startedAt: Date.now(),
    // Snapshot tiles known at the actual submission boundary as a second guard
    // for tiles that were seen earlier but are currently virtualized away.
    knownBeforeStart: new Set(__flowKnownTileIds)
  };
}

function shouldRejectFlowTileForRun(tileId, identity) {
  if (!tileId || !identity) {
    // If this fires on every candidate image during a real run, Flow's DOM
    // no longer exposes a data-media-id on the result <img> and this guard
    // is rejecting every image unconditionally.
    // See NS.getFlowTileId()/NS.findFlowTileContainer() above.
    NS.clientLog('warn', 'Flow', `Tile identity guard rejected an image: no data-media-id found (tileId=${tileId}).`);
    return true; // Never accept an unbound image.
  }
  if (identity.beforeTileIds?.has(tileId)) return true;
  if (identity.knownBeforeStart?.has(tileId)) return true;
  const scrollMountedAt = __flowScrollMountedTileIds.get(tileId) || 0;
  if (scrollMountedAt >= identity.startedAt) {
    // Previously silent -- this is the rejection path that was throwing away
    // genuinely new tiles (see markFlowProgrammaticScroll() comment above).
    // Logged now so a real DOM-markup regression (constant rejections here)
    // is distinguishable from an occasional, expected scroll-guard hit.
    NS.clientLog('warn', 'Flow', `Tile identity guard rejected an image: tile ${tileId} was marked scroll-mounted at ${scrollMountedAt} (run started ${identity.startedAt}).`);
    return true;
  }
  return false;
}

// Install immediately (not only when the first prompt is submitted) so scrolls
// that occur while the queue is idle still contribute to the old-tile ledger.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ensureFlowTileIdentityTracker, { once: true });
} else {
  ensureFlowTileIdentityTracker();
}

function ensureKeepAlive() {
  __kaRefs++;
  if (__kaLingerTimer) { clearTimeout(__kaLingerTimer); __kaLingerTimer = null; }
  if (!__kaStop) __kaStop = NS.preventBackgroundThrottling();
}
function releaseKeepAlive() {
  __kaRefs = Math.max(0, __kaRefs - 1);
  if (__kaRefs === 0 && __kaStop && !__kaLingerTimer) {
    __kaLingerTimer = setTimeout(() => {
      __kaLingerTimer = null;
      if (__kaRefs === 0 && __kaStop) { try { __kaStop(); } catch (e) { } __kaStop = null; }
    }, 60000);
  }
}

async function generateImage(prompt, itemId) {
  return runExclusiveGeneration(async () => {
    // Start background keep-alive to prevent tab throttle
    ensureKeepAlive();
    NS.activeGenerationItemId = itemId || null;
    try {
      return await NS.generateImageInternal(prompt, itemId);
    } finally {
      NS.activeGenerationItemId = null;
      releaseKeepAlive();
    }
  });
}
  // ── Exports for other content-script module files ──
  NS.__capturedResultKeys = __capturedResultKeys;
  NS.__capturedResultSrcs = __capturedResultSrcs;
  NS.__capturedDataUrls = __capturedDataUrls;
  NS.ensureKeepAlive = ensureKeepAlive;
  NS.releaseKeepAlive = releaseKeepAlive;
  NS.generateImage = generateImage;
  NS.runExclusiveGeneration = runExclusiveGeneration;
  NS.createFlowRunIdentity = createFlowRunIdentity;
  NS.shouldRejectFlowTileForRun = shouldRejectFlowTileForRun;
  NS.markFlowProgrammaticScroll = markFlowProgrammaticScroll;
})();