// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;



// Wait for a newly generated image to appear in the Flow project, then return it
// Best-effort detection of how many images Flow will produce (the "x2" / "x4"
// chip near the model selector). Defaults to 1 if it cannot be determined.
function getFlowExpectedCount() {
  const clamp = (n) => (Number.isFinite(n) && n >= 1 && n <= 8 ? n : null);
  try {
    // Prefer an explicitly selected / pressed "outputs per prompt" control.
    const controls = document.querySelectorAll(
      'button[aria-pressed="true"], [role="button"][aria-pressed="true"], ' +
      '[aria-checked="true"], [data-selected="true"], [class*="selected" i]'
    );
    for (const el of controls) {
      const txt = (el.textContent || '').trim();
      let m = txt.match(/(?:^|[x\u00d7\s])([1-8])\b/i);
      if (m) { const n = clamp(parseInt(m[1], 10)); if (n) return n; }
      const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      m = aria.match(/([1-8])\s*(?:images?|outputs?|results?)/i);
      if (m) { const n = clamp(parseInt(m[1], 10)); if (n) return n; }
    }
    // Fallback: any "xN" / "\u00d7N" badge, or an "N images/outputs" label.
    const els = document.querySelectorAll('button, span, div, p, [aria-label]');
    for (const el of els) {
      const txt = (el.textContent || '').trim();
      let m = txt.match(/^[x\u00d7]\s*([1-8])$/i);
      if (m) { const n = clamp(parseInt(m[1], 10)); if (n) return n; }
      const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      m = aria.match(/([1-8])\s*(?:images?|outputs?|results?)\b/i);
      if (m) { const n = clamp(parseInt(m[1], 10)); if (n) return n; }
    }
  } catch { /* ignore */ }
  return 1;
}

// Detect whether Google Flow is STILL actively generating any tile in the batch.
// This is what lets us wait for the whole x2/x3/x4 batch to finish instead of
// grabbing the first finished image and racing ahead to the next prompt.
function isFlowGenerating() {
  if (NS.PROVIDER !== 'flow') return false;
  const isVisible = (el) => {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch { return false; }
  };

  // 1) Explicit busy / progress signals.
  const busy = document.querySelector('[aria-busy="true"], [role="progressbar"]');
  if (busy && isVisible(busy)) return true;

  // 2) "Generating" / "Creating" / percentage text in small status elements.
  const textEls = document.querySelectorAll('button, span, div, p');
  for (const el of textEls) {
    const text = (el.textContent || '').trim().toLowerCase();
    if (!text || text.length > 40) continue;
    const isGeneratingText = text.includes('generating') || text.includes('creating');
    const isPercent = /^\d{1,3}\s*%$/.test(text) || /\d{1,3}%\s*(?:complete|done)?/.test(text);
    if ((isGeneratingText || isPercent) && isVisible(el)) {
      console.log('BulkyGen Flow: generation active ->', text.slice(0, 30));
      return true;
    }
  }

  // 3) Loading skeleton / shimmer / spinner tiles in the results area.
  const loaders = document.querySelectorAll(
    '[class*="animate-spin"], [class*="spinner" i], [class*="skeleton" i], [class*="shimmer" i], [class*="loading" i]'
  );
  for (const el of loaders) {
    if (isVisible(el)) {
      console.log('BulkyGen Flow: generation active -> loading tile');
      return true;
    }
  }

  return false;
}

// Wait for and collect ALL newly generated images (Flow x2 / x4 produce several).
// Returns an array of <img> elements that were not present before submitting.
// flowRunIdentity tracks both tiles present at submission and tiles previously
// observed by the page-wide ledger. This prevents a virtualized older tile from
// becoming eligible merely because it mounts after the user scrolls.
async function waitForFlowResults(beforeKeys, flowRunIdentity, expectedCount = 1, timeoutMs = 120000, beforeErrorTileCount = 0) {
  const start = Date.now();
  const found = new Map(); // key -> img element
  let lastChangeAt = Date.now();

  // Settle window required AFTER generation looks idle before we trust the batch
  // is complete (guards against a brief gap between tiles finishing).
  const SETTLE_MS = 500;
  // How long to keep waiting for missing tiles once Flow is no longer generating
  // (a tile may have failed). Only used when we have fewer than expected.
  const STRAGGLER_GIVEUP_MS = 20000;

  while (Date.now() - start < timeoutMs) {
    // Hard cap: never accept more "new" images than this prompt actually
    // asked Flow to generate. This is a deliberate backstop independent of
    // whatever detection logic runs below -- if beforeKeys ever
    // under-counts what already existed (for any reason, including ones we
    // haven't seen yet), this is what stops it from snowballing into
    // capturing the user's entire project instead of just this prompt's
    // result(s).
    if (found.size < expectedCount) {
      const imgs = NS.collectResultElements().filter(el => el.tagName === 'IMG');
      for (const img of imgs) {
        if (found.size >= expectedCount) break;
        const src = img.currentSrc || img.src || '';
        if (!src) continue;
        // Only count images that have actually finished decoding.
        if (!img.complete) continue;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w < 256 || h < 256) continue;
        const key = NS.elementKey(img);
        if (beforeKeys.has(key)) continue;
        if (NS.__capturedResultSrcs.has(src) || NS.__capturedResultKeys.has(key)) continue;
        // ── Strict tile-identity guard (scroll/lazy-load defense) ──
        // Every accepted Flow image must have a stable tile ID, and that ID
        // must be newly created for THIS run. A candidate that is not bound to
        // a tile, was already present, was seen in a prior viewport, or mounted
        // immediately after a user scroll is rejected rather than guessed at.
        const tileId = NS.getFlowTileId(img);
        if (NS.shouldRejectFlowTileForRun(tileId, flowRunIdentity)) {
          continue;
        }
        if (!found.has(key)) {
          found.set(key, img);
          lastChangeAt = Date.now();
          console.log('BulkyGen Flow: new image ' + found.size + '/' + expectedCount + ' (' + w + 'x' + h + ')');
        } else {
          found.set(key, img); // refresh element reference
        }
      }
    }

    const stableFor = Date.now() - lastChangeAt;
    const generating = isFlowGenerating();

    if (generating) {
      // Flow is still rendering one or more tiles in this batch. DO NOT return
      // yet, otherwise the unfinished tiles leak into the next prompt's capture.
      // Defensive escape hatch: if we already have everything we expected and it
      // has been stable for a long time, a lingering spinner shouldn't trap us.
      if (found.size >= expectedCount && stableFor > STRAGGLER_GIVEUP_MS) {
        console.log('BulkyGen Flow: have full batch; ignoring stale generating indicator');
        break;
      }
      await NS.waitUnthrottled(150);
      continue;
    }

    // Flow is no longer actively generating.
    if (found.size >= expectedCount && stableFor > SETTLE_MS) {
      // Whole batch finished and settled.
      break;
    }
    if (found.size >= 1 && found.size < expectedCount && stableFor > STRAGGLER_GIVEUP_MS) {
      // Generation stopped but fewer images than expected showed up (a tile
      // likely failed). Return what we actually have rather than hang.
      console.log('BulkyGen Flow: generation idle with ' + found.size + '/' + expectedCount + ' image(s); returning partial batch');
      break;
    }
    if (found.size === 0) {
      // A failed generation renders as a <flow-error-tile> with no img/
      // data-media-id, so it can never satisfy the identity guard above and
      // this loop would otherwise sit through the full timeout doing
      // nothing useful. If a NEW error tile (one that wasn't already in the
      // grid before this prompt was submitted) shows up once Flow is no
      // longer generating, treat that as this run's own failure and return
      // immediately -- this makes the caller's retry happen faster and
      // reduces the window where a slow-but-succeeding sibling request
      // could still be resolving when the retry fires.
      const currentErrorTileCount = document.querySelectorAll('flow-error-tile').length;
      if (!generating && currentErrorTileCount > beforeErrorTileCount && stableFor > SETTLE_MS) {
        console.log('BulkyGen Flow: detected a new error tile with 0 images captured; failing fast instead of waiting out the timeout');
        NS.clientLog('warn', 'Flow', 'A new "Failed to generate" tile appeared for this prompt; returning early instead of waiting the full timeout.');
        break;
      }
    }
    // found.size === 0 (or still settling) -> keep waiting until timeout.
    await NS.waitUnthrottled(150);
  }

  await NS.waitUnthrottled(150); // let the last image fully decode
  return Array.from(found.values());
}
  // ── Exports for other content-script module files ──
  NS.getFlowExpectedCount = getFlowExpectedCount;
  NS.waitForFlowResults = waitForFlowResults;
})();
