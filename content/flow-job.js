// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
//
// Flow job state machine (replaces the old submitFlowPromptInternal).
//
// The old flow was one big function that returned "success" even when nothing
// was captured, and the background then answered every "no image" by clicking
// Generate AGAIN. Two different questions were being conflated:
//
//     1. Did Flow accept (and charge for) the prompt?      -> SUBMIT
//     2. Did we manage to read the resulting image(s)?     -> CAPTURE
//
// They are now separate, and separately reported:
//
//   - SUBMIT is gated by the background job ledger (write-ahead authorization)
//     and verified by a receipt (composer cleared / button disabled / new tile).
//   - CAPTURE can be repeated for free via flowRecoverCapture, which re-scans
//     the tiles created by that job and NEVER clicks Generate.
//   - Every phase is pushed to the background as a 'jobEvent' so the extension
//     (and the popup / tool page) always knows what the page is doing.
//
// Result shape (what the background receives):
//   { success, phase, submitted, clicked, receiptBy, provenFailed, noResubmit,
//     imageData, multipleImages, error, counts, meta }
//   phase: captured | submitted_no_capture | generation_failed | submit_failed
//          | blocked | no_context
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;

  const CTX_PREFIX = 'bulkygen.jobctx.';
  const HEARTBEAT_MS = 2000;
  const CAPTURE_TIMEOUT_MS = 120000;
  const MAX_CTX_TILE_IDS = 4000;

  // ── messaging helpers ─────────────────────────────────────────────────────
  function send(msg, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v === undefined ? null : v); } };
      const t = setTimeout(() => finish(null), timeoutMs || 4000);
      try {
        Promise.resolve(NS.ext.runtime.sendMessage(msg)).then(finish, () => finish(null));
      } catch (e) { finish(null); }
    });
  }

  function counts() {
    return {
      tiles: document.querySelectorAll('flow-grid-tile-container').length,
      imgs: document.querySelectorAll('img[data-media-id]').length,
      errors: document.querySelectorAll('flow-error-tile').length,
      generating: typeof NS.isFlowGenerating === 'function' ? !!NS.isFlowGenerating() : null
    };
  }

  // Fire-and-forget realtime event to the background ledger / popup / tool.
  function emit(jobKey, itemId, phase, detail, extra) {
    try {
      const msg = Object.assign({ action: 'jobEvent', jobKey, itemId, phase, detail: detail || '', counts: counts(), at: Date.now() }, extra || {});
      Promise.resolve(NS.ext.runtime.sendMessage(msg)).catch(() => { });
    } catch (e) { /* ignore */ }
  }

  // ── per-job snapshot, persisted so capture-only recovery survives a page reload ──
  function saveCtx(itemId, ctx) {
    NS.__jobCtx = NS.__jobCtx || {};
    NS.__jobCtx[itemId] = ctx;
    try { sessionStorage.setItem(CTX_PREFIX + itemId, JSON.stringify(ctx)); } catch (e) { /* ignore */ }
  }
  function loadCtx(itemId) {
    if (NS.__jobCtx && NS.__jobCtx[itemId]) return NS.__jobCtx[itemId];
    try {
      const raw = sessionStorage.getItem(CTX_PREFIX + itemId);
      if (raw) { const c = JSON.parse(raw); (NS.__jobCtx = NS.__jobCtx || {})[itemId] = c; return c; }
    } catch (e) { /* ignore */ }
    return null;
  }

  function result(fields) {
    return Object.assign({
      success: false, phase: 'submit_failed', submitted: false, clicked: false, receiptBy: '',
      provenFailed: false, noResubmit: false, imageData: null, multipleImages: [], error: null, counts: counts()
    }, fields || {});
  }

  // Read the bytes of each new tile image. Failures here are NOT submit failures.
  async function captureImages(resultImgs, baseMeta) {
    const images = [];
    let failed = 0, duplicates = 0;
    for (const img of resultImgs) {
      const src = img.currentSrc || img.src || '';
      if (!src) { failed++; continue; }
      try {
        const data = await NS.getImageAsBase64(src, img);
        if (!data) { failed++; continue; }
        if (NS.__capturedDataUrls.has(data)) { duplicates++; continue; }
        NS.__capturedResultKeys.add(NS.elementKey(img));
        NS.__capturedResultSrcs.add(src);
        NS.__capturedDataUrls.add(data);
        images.push({
          imageData: data,
          meta: Object.assign({}, baseMeta, {
            src,
            tileId: NS.getFlowTileId(img),
            width: img.naturalWidth || img.width || 0,
            height: img.naturalHeight || img.height || 0
          })
        });
      } catch (e) {
        failed++;
        NS.clientLog('warn', 'Flow', `Image bytes could not be read (${e && e.message}); the job stays submitted - will re-scan, not resubmit.`);
      }
    }
    return { images, failed, duplicates };
  }

  // Wait for this job's tiles, report live progress, then capture. Shared by the
  // live submit path and the capture-only recovery path.
  async function waitAndCapture(ctx, opts) {
    const { identity, beforeKeys, timeoutMs, submitted, receiptBy } = opts;
    const hb = setInterval(() => {
      emit(ctx.jobKey, ctx.itemId, 'generating', `waiting for result (${Math.round((Date.now() - ctx.startedAt) / 1000)}s)`);
    }, HEARTBEAT_MS);
    let resultImgs = [];
    try {
      resultImgs = await NS.waitForFlowResults(beforeKeys, identity, ctx.expected || 1, timeoutMs, ctx.beforeErrors || 0);
    } catch (e) {
      NS.clientLog('warn', 'Flow', `waitForFlowResults threw: ${e && e.message}`);
    } finally {
      clearInterval(hb);
    }

    const c = counts();
    const baseMeta = { provider: 'flow', itemId: ctx.itemId, type: 'image' };

    if (resultImgs.length === 0) {
      const newErrors = c.errors - (ctx.beforeErrors || 0);
      if (newErrors > 0 && !c.generating) {
        emit(ctx.jobKey, ctx.itemId, 'generation_failed', 'Flow rendered a failed tile for this prompt', { log: 'failed tile seen' });
        return result({
          phase: 'generation_failed', submitted: true, clicked: true, receiptBy, provenFailed: true,
          error: 'Flow reported a failed generation (error tile) for this prompt', counts: c
        });
      }
      emit(ctx.jobKey, ctx.itemId, 'no_result_yet', c.generating ? 'still generating at timeout' : 'no new tile found');
      return result({
        phase: 'submitted_no_capture', submitted: !!submitted, clicked: true, receiptBy,
        error: c.generating ? 'Still generating when the wait window ended' : 'No new result tile appeared in the wait window', counts: c
      });
    }

    emit(ctx.jobKey, ctx.itemId, 'capturing', `${resultImgs.length} tile(s) found`);
    const cap = await captureImages(resultImgs, baseMeta);
    if (cap.images.length === 0) {
      emit(ctx.jobKey, ctx.itemId, 'capture_failed', `tiles found but bytes unreadable (failed=${cap.failed}, duplicates=${cap.duplicates})`);
      return result({
        phase: 'submitted_no_capture', submitted: true, clicked: true, receiptBy,
        error: `Result tiles found but image bytes could not be captured (failed=${cap.failed}, duplicates=${cap.duplicates})`,
        counts: c, meta: Object.assign({}, baseMeta, { captureFailed: cap.failed, duplicates: cap.duplicates })
      });
    }
    emit(ctx.jobKey, ctx.itemId, 'captured', `${cap.images.length} image(s) captured`);
    return result({
      success: true, phase: 'captured', submitted: true, clicked: true, receiptBy,
      imageData: cap.images[0].imageData, multipleImages: cap.images, counts: c,
      meta: Object.assign({}, baseMeta, { captured: cap.images.length, receiptBy })
    });
  }

  // ── SUBMIT ────────────────────────────────────────────────────────────────
  async function submitFlowPrompt(prompt, itemId, aspectRatio, jobKey, callId) {
    return NS.runExclusiveGeneration(() => submitFlowPromptInternal(prompt, itemId, aspectRatio, jobKey, callId));
  }

  async function submitFlowPromptInternal(prompt, itemId, aspectRatio, jobKey, callId) {
    if (NS.PROVIDER !== 'flow') {
      NS.clientLog('error', 'Flow', `submitFlowPrompt called but detected provider is "${NS.PROVIDER}", not "flow".`);
      throw new Error('Flow submit requested on non-Flow page');
    }
    jobKey = jobKey || itemId;
    NS.ensureKeepAlive();
    // The unload guard reports a mid-generation page teardown using this id, and
    // the background waits for results keyed by the per-call id.
    NS.activeGenerationItemId = callId || itemId || null;
    let authorized = false;

    try {
      emit(jobKey, itemId, 'start', `"${String(prompt).slice(0, 60)}"`);

      const uiReady = await NS.waitForProviderUI();
      if (!uiReady) {
        emit(jobKey, itemId, 'ui_not_ready', 'prompt box not visible');
        return result({ phase: 'submit_failed', error: 'Flow UI not ready. Make sure the prompt field is visible on the page.' });
      }
      const editor = NS.findFlowComposer();
      if (!editor) {
        emit(jobKey, itemId, 'ui_not_ready', 'composer not found');
        return result({ phase: 'submit_failed', error: 'Could not find the Flow prompt box' });
      }

      if (aspectRatio) {
        emit(jobKey, itemId, 'ratio', aspectRatio);
        try { await NS.ensureFlowAspectRatio(aspectRatio); }
        catch (e) { NS.clientLog('warn', 'Flow', `Aspect ratio selection failed: ${e && e.message || e}`); }
      }

      // "Before" snapshot - see the long note this replaces: Flow virtualizes its
      // grid, so we snapshot loaded image keys AND every data-media-id.
      const beforeKeys = new Set();
      const beforeTileIds = new Set();
      NS.collectResultElements()
        .filter(el => {
          if (el.tagName !== 'IMG') return false;
          const src = el.currentSrc || el.src || '';
          if (!src || !el.complete) return false;
          return (el.naturalWidth || el.width || 0) >= 256 && (el.naturalHeight || el.height || 0) >= 256;
        })
        .forEach(el => beforeKeys.add(NS.elementKey(el)));
      for (const k of NS.__capturedResultKeys) beforeKeys.add(k);
      document.querySelectorAll('img[data-media-id]').forEach(img => {
        const id = img.getAttribute('data-media-id');
        if (id) beforeTileIds.add(id);
      });
      const identity = NS.createFlowRunIdentity(beforeTileIds);
      const beforeErrors = document.querySelectorAll('flow-error-tile').length;
      const expected = NS.getFlowExpectedCount();

      const ctx = {
        itemId, jobKey, startedAt: identity.startedAt || Date.now(), expected, beforeErrors,
        beforeTileIds: Array.from(new Set([...beforeTileIds, ...(identity.knownBeforeStart || [])])).slice(-MAX_CTX_TILE_IDS)
      };
      saveCtx(itemId, ctx); // persisted BEFORE anything is clicked

      NS.markFlowProgrammaticScroll();
      editor.scrollIntoView({ behavior: 'instant', block: 'center' });
      await NS.waitUnthrottled(150);

      const injected = await NS.injectFlowPrompt(editor, prompt);
      if (!injected.text) {
        emit(jobKey, itemId, 'inject_failed', 'prompt text did not reach the editor');
        return result({ phase: 'submit_failed', error: 'Failed to inject the prompt into the Flow composer' });
      }
      emit(jobKey, itemId, 'injected', injected.registered ? 'prompt registered' : 'prompt inserted, button not confirmed ready');
      await NS.waitUnthrottled(250);

      // Write-ahead credit guard + click. The gate runs inside clickFlowGenerate,
      // right before the first real click.
      const gate = async () => {
        const verdict = await send({ action: 'jobAuthorizeSubmit', jobKey, itemId, prompt, aspectRatio: aspectRatio || null }, 6000);
        if (!verdict) return { allowed: false, reason: 'job ledger did not answer (service worker unreachable) - refusing to click so credits are never spent blind' };
        authorized = !!verdict.allowed;
        return verdict;
      };
      emit(jobKey, itemId, 'submit_click', 'asking ledger for permission, then clicking Generate');
      const click = await NS.clickFlowGenerate(editor, prompt, gate);

      if (click.blocked) {
        emit(jobKey, itemId, 'blocked', click.reason);
        return result({ phase: 'blocked', noResubmit: true, error: `Submit refused by job ledger: ${click.reason}` });
      }
      if (!click.clicked) {
        if (authorized) await send({ action: 'jobRefundSubmit', jobKey, reason: click.reason || 'no click dispatched' }, 3000);
        emit(jobKey, itemId, 'submit_failed', click.reason || 'Generate was never clicked');
        return result({ phase: 'submit_failed', error: click.reason || 'Generate button could not be clicked' });
      }

      if (click.submitted) {
        await send({ action: 'jobConfirmSubmit', jobKey, by: click.by }, 3000);
        emit(jobKey, itemId, 'submit_confirmed', `receipt: ${click.by}`);
      } else {
        emit(jobKey, itemId, 'submit_unconfirmed', 'clicked, but no receipt seen - will watch for a result, will NOT click again');
      }

      return await waitAndCapture(ctx, {
        identity, beforeKeys, timeoutMs: CAPTURE_TIMEOUT_MS, submitted: click.submitted, receiptBy: click.by
      });
    } finally {
      NS.activeGenerationItemId = null;
      NS.releaseKeepAlive();
    }
  }

  // ── RECOVER (capture only - never clicks Generate) ─────────────────────────
  async function flowRecoverCapture(itemId, jobKey, waitMs, callId) {
    return NS.runExclusiveGeneration(async () => {
      jobKey = jobKey || itemId;
      NS.ensureKeepAlive();
      NS.activeGenerationItemId = callId || itemId || null;
      try {
        const ctx = loadCtx(itemId);
        if (!ctx) {
          emit(jobKey, itemId, 'no_context', 'no saved snapshot for this item');
          return result({ phase: 'no_context', noResubmit: true, error: 'No saved snapshot for this item - cannot tell which tiles belong to it' });
        }
        emit(jobKey, itemId, 'recover_start', 'capture-only re-scan (no Generate click)');
        const known = new Set(ctx.beforeTileIds || []);
        const identity = { beforeTileIds: known, startedAt: ctx.startedAt, knownBeforeStart: known };
        return await waitAndCapture(ctx, {
          identity, beforeKeys: new Set(), timeoutMs: waitMs || 45000, submitted: false, receiptBy: 'recover'
        });
      } finally {
        NS.activeGenerationItemId = null;
        NS.releaseKeepAlive();
      }
    });
  }

  // ── PROBE (read-only status so the extension is never blind) ───────────────
  function flowProbe() {
    let composer = false, submitReady = false;
    try {
      const ed = NS.findFlowComposer();
      composer = !!ed;
      submitReady = !!(ed && NS.isFlowButtonReady(NS.findFlowSubmitButton(ed)));
    } catch (e) { /* ignore */ }
    return {
      ok: true, provider: NS.PROVIDER, url: location.href, composer, submitReady,
      activeItemId: NS.activeGenerationItemId || null, counts: counts(), at: Date.now()
    };
  }

  NS.submitFlowPrompt = submitFlowPrompt;
  NS.flowRecoverCapture = flowRecoverCapture;
  NS.flowProbe = flowProbe;
})();
