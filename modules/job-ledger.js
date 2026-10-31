/**
 * BulkyGen Job Ledger  (service-worker module, loaded via importScripts)
 *
 * ONE job = ONE thing that costs credits when submitted (a pipeline record or a
 * queue item). The ledger is the single source of truth for "has this job
 * already been paid for, and what happened to it?". Every layer that can cause
 * a Flow submission (generation loop, pipeline retry wrapper, popup
 * "regenerate", the tool page) must ask the ledger first, and the content
 * script asks it again at the very last moment before it clicks Generate
 * (write-ahead authorization). That is what makes a resubmission impossible
 * unless there is proof the previous submission produced nothing.
 *
 * States:
 *   queued        nothing submitted yet
 *   submitting    click authorized, outcome unknown
 *   submitted     Flow accepted it (receipt seen) - waiting for / capturing result
 *   generating    live progress seen on the page
 *   captured      image bytes are safely stored (IndexedDB) - NEVER regenerate
 *   processing    post-processing (compress / metadata / Drive / Supabase)
 *   done          finished end to end
 *   failed        Flow showed a failed tile for this job (proven failure)
 *   needs_attention  ambiguous (accepted but nothing captured); a human decides
 *   cancelled     stopped by the user
 *
 * Exposed as globalThis.bulkygenJobs.
 */
(function () {
  'use strict';

  const KEY = 'bulkygenJobs';
  const BREAKER_KEY = 'bulkygenJobBreaker';

  const DEFAULTS = {
    maxSubmitsPerJob: 2,          // 1 original + 1 retry, only after PROVEN failure
    maxRecoverTries: 3,           // capture-only re-scans (never click Generate)
    recoverWaitMs: 45000,         // how long each capture-only re-scan waits
    guardTtlMs: 30 * 60 * 1000,   // an unresolved/blocked job stops guarding after this
    capturedTtlMs: 24 * 60 * 60 * 1000,
    breakerLimit: 3               // consecutive failed jobs before the run halts
  };
  let cfg = Object.assign({}, DEFAULTS);

  const jobs = new Map();
  const listeners = new Set();
  let loadPromise = null;
  let saveChain = Promise.resolve();
  let lastPersistAt = 0;
  let breaker = { consecutive: 0 };

  const api = () => globalThis.ext;

  function now() { return Date.now(); }
  function clone(o) { return o ? JSON.parse(JSON.stringify(o)) : o; }

  async function load() {
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const d = await api().storage.local.get([KEY, BREAKER_KEY]);
          const stored = d[KEY] || {};
          for (const [k, v] of Object.entries(stored)) jobs.set(k, v);
          if (d[BREAKER_KEY] && typeof d[BREAKER_KEY].consecutive === 'number') breaker = d[BREAKER_KEY];
        } catch (e) { /* start empty */ }
      })();
    }
    return loadPromise;
  }

  function persist(force) {
    const t = now();
    if (!force && t - lastPersistAt < 2500) return saveChain;
    lastPersistAt = t;
    const snapshot = Object.fromEntries(jobs);
    saveChain = saveChain
      .then(() => api().storage.local.set({ [KEY]: snapshot, [BREAKER_KEY]: breaker }))
      .catch(() => { });
    return saveChain;
  }

  function publish(job, type, note) {
    const payload = { type: type || 'job', job: clone(job), note: note || null };
    for (const fn of listeners) { try { fn(payload); } catch (e) { /* ignore */ } }
    try {
      const p = api().runtime.sendMessage({ action: 'jobProgress', job: payload.job, note: payload.note });
      if (p && p.catch) p.catch(() => { });
    } catch (e) { /* popup closed */ }
  }

  function addEvent(job, text) {
    job.events = job.events || [];
    job.events.push({ t: now(), text });
    if (job.events.length > 25) job.events.splice(0, job.events.length - 25);
  }

  function fresh(key, info) {
    const t = now();
    return {
      key,
      prompt: (info && info.prompt) || '',
      aspectRatio: (info && info.aspectRatio) || null,
      source: (info && info.source) || 'queue',
      itemId: (info && info.itemId) || null,
      state: 'queued',
      phase: 'queued',
      detail: '',
      error: null,
      submitCount: 0,
      recoverTries: 0,
      provenFailed: false,
      lastSubmit: null,
      prevSubmit: null,
      captured: false,
      imageCount: 0,
      createdAt: t,
      updatedAt: t,
      lastEventAt: t,
      events: []
    };
  }

  function expired(j) {
    const age = now() - (j.updatedAt || 0);
    if (j.state === 'captured' || j.state === 'processing') return age > cfg.capturedTtlMs;
    if (j.state === 'done') return true; // a finished job never guards a NEW run of the same key
    return age > cfg.guardTtlMs;
  }

  function configure(settings) {
    if (!settings) return;
    const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);
    if (num(settings.maxSubmitsPerJob) !== null && settings.maxSubmitsPerJob >= 1) cfg.maxSubmitsPerJob = settings.maxSubmitsPerJob;
    if (num(settings.maxRecoverTries) !== null) cfg.maxRecoverTries = settings.maxRecoverTries;
    if (num(settings.breakerLimit) !== null && settings.breakerLimit >= 1) cfg.breakerLimit = settings.breakerLimit;
    if (num(settings.jobGuardTtlMin) !== null && settings.jobGuardTtlMin > 0) cfg.guardTtlMs = settings.jobGuardTtlMin * 60000;
  }

  async function ensure(key, info) {
    await load();
    let j = jobs.get(key);
    if (j && expired(j)) { j = null; jobs.delete(key); }
    if (!j) {
      j = fresh(key, info);
      jobs.set(key, j);
      persist(true);
      publish(j, 'job', 'created');
    } else if (info) {
      if (info.prompt) j.prompt = info.prompt;
      if (info.aspectRatio !== undefined && info.aspectRatio !== null) j.aspectRatio = info.aspectRatio;
      if (info.itemId) j.itemId = info.itemId;
    }
    return j;
  }

  async function get(key) { await load(); const j = jobs.get(key); return j ? j : null; }

  /**
   * What is allowed to happen next for this job?
   *   reuse    images already captured - do not touch Flow
   *   submit   click Generate (costs credits)
   *   recover  capture-only re-scan of the existing result tiles (free)
   *   blocked  stop and ask a human
   */
  function decide(j) {
    if (!j) return { action: 'submit', reason: 'no ledger entry' };
    if (j.captured || j.state === 'captured' || j.state === 'processing') return { action: 'reuse', reason: 'already captured' };
    if (j.submitCount === 0 || !j.lastSubmit) return { action: 'submit', reason: 'never submitted' };
    if (j.provenFailed) {
      if (j.submitCount < cfg.maxSubmitsPerJob) return { action: 'submit', reason: 'previous submission proven failed' };
      return { action: 'blocked', reason: `submit budget exhausted (${j.submitCount}/${cfg.maxSubmitsPerJob}) after proven failures` };
    }
    if (j.lastSubmit.confirmed) {
      if (j.recoverTries < cfg.maxRecoverTries) return { action: 'recover', reason: 'submission confirmed; result not captured yet' };
      return { action: 'blocked', reason: 'Flow accepted the prompt but no result could be captured - NOT resubmitting (would double-charge). Check the Flow tab.' };
    }
    // Clicked but no receipt: ambiguous. Look first, never assume it failed.
    if (j.recoverTries < 1) return { action: 'recover', reason: 'submit unconfirmed; scanning for a result before any resubmit' };
    if (j.submitCount < cfg.maxSubmitsPerJob) return { action: 'submit', reason: 'unconfirmed submit left no trace after a scan' };
    return { action: 'blocked', reason: `submit budget exhausted (${j.submitCount}/${cfg.maxSubmitsPerJob})` };
  }

  async function decideFor(key) { await load(); return decide(jobs.get(key)); }

  /** Write-ahead gate. The content script calls this right before it clicks Generate. */
  async function authorizeSubmit(key, itemId, info) {
    const j = await ensure(key, Object.assign({}, info, { itemId }));
    const d = decide(j);
    if (d.action !== 'submit') {
      addEvent(j, `submit REFUSED: ${d.reason}`);
      publish(j, 'job', 'submit refused');
      return { allowed: false, reason: d.reason, action: d.action, submitCount: j.submitCount };
    }
    j.prevSubmit = j.lastSubmit;
    j.submitCount += 1;
    j.lastSubmit = { itemId: itemId || j.itemId, at: now(), confirmed: false, by: null };
    j.provenFailed = false;
    j.recoverTries = 0;
    j.itemId = itemId || j.itemId;
    j.state = 'submitting';
    j.phase = 'submit_click';
    j.detail = `authorized submit ${j.submitCount}/${cfg.maxSubmitsPerJob}`;
    j.error = null;
    j.updatedAt = now(); j.lastEventAt = j.updatedAt;
    addEvent(j, j.detail);
    await persist(true);
    publish(j, 'job', 'submit authorized');
    return { allowed: true, submitCount: j.submitCount, max: cfg.maxSubmitsPerJob };
  }

  async function refundSubmit(key, why) {
    await load();
    const j = jobs.get(key);
    if (!j || !j.lastSubmit || j.lastSubmit.confirmed) return;
    j.submitCount = Math.max(0, j.submitCount - 1);
    j.lastSubmit = j.prevSubmit || null;
    j.prevSubmit = null;
    j.state = 'queued'; j.phase = 'submit_aborted'; j.detail = why || 'no click was made';
    j.updatedAt = now();
    addEvent(j, `refund: ${j.detail}`);
    await persist(true);
    publish(j, 'job', 'refunded');
  }

  async function noteConfirmed(key, by) {
    await load();
    const j = jobs.get(key); if (!j || !j.lastSubmit) return;
    j.lastSubmit.confirmed = true; j.lastSubmit.by = by || 'unknown';
    j.state = 'submitted'; j.phase = 'submit_confirmed'; j.detail = `receipt: ${by || 'unknown'}`;
    j.updatedAt = now(); j.lastEventAt = j.updatedAt;
    addEvent(j, j.detail);
    await persist(true);
    publish(j, 'job', 'confirmed');
  }

  async function noteRecoverTry(key) {
    await load();
    const j = jobs.get(key); if (!j) return;
    j.recoverTries += 1;
    j.phase = 'recover'; j.detail = `capture-only scan ${j.recoverTries}/${cfg.maxRecoverTries}`;
    j.updatedAt = now(); j.lastEventAt = j.updatedAt;
    addEvent(j, j.detail);
    persist(true);
    publish(j, 'job', 'recover');
  }

  async function noteProvenFailure(key, why) {
    await load();
    const j = jobs.get(key); if (!j) return;
    j.provenFailed = true; j.state = 'failed'; j.phase = 'generation_failed';
    j.error = why || 'Flow reported a failed generation'; j.detail = j.error;
    j.updatedAt = now();
    addEvent(j, `proven failure: ${j.error}`);
    await persist(true);
    publish(j, 'job', 'failed');
  }

  async function markCaptured(key, info) {
    await load();
    const j = jobs.get(key); if (!j) return;
    j.captured = true; j.state = 'captured'; j.phase = 'captured';
    j.imageCount = (info && info.imageCount) || j.imageCount || 0;
    j.itemId = (info && info.itemId) || j.itemId;
    j.error = null; j.detail = `${j.imageCount} image(s) stored`;
    j.updatedAt = now(); j.lastEventAt = j.updatedAt;
    addEvent(j, j.detail);
    await persist(true);
    publish(j, 'job', 'captured');
  }

  async function setStage(key, state, detail) {
    await load();
    const j = jobs.get(key); if (!j) return;
    j.state = state; j.phase = state; j.detail = detail || '';
    j.updatedAt = now(); j.lastEventAt = j.updatedAt;
    addEvent(j, `${state}${detail ? ': ' + detail : ''}`);
    await persist(true);
    publish(j, 'job', state);
  }

  async function markNeedsAttention(key, reason) {
    await load();
    const j = jobs.get(key); if (!j) return;
    j.state = 'needs_attention'; j.phase = 'needs_attention';
    j.error = reason || 'needs attention'; j.detail = j.error;
    j.updatedAt = now();
    addEvent(j, `NEEDS ATTENTION: ${j.error}`);
    await persist(true);
    publish(j, 'job', 'needs_attention');
  }

  async function markCancelled(key) {
    await load();
    const j = jobs.get(key); if (!j || j.captured) return;
    j.state = 'cancelled'; j.phase = 'cancelled'; j.updatedAt = now();
    persist(true); publish(j, 'job', 'cancelled');
  }

  /** User-approved reset: allows a fresh submit budget. Never silent. */
  async function release(key) {
    await load();
    const j = jobs.get(key); if (!j) return false;
    const info = { prompt: j.prompt, aspectRatio: j.aspectRatio, source: j.source, itemId: j.itemId };
    const f = fresh(key, info);
    f.createdAt = j.createdAt;
    addEvent(f, 'guard released by user');
    jobs.set(key, f);
    await persist(true);
    publish(f, 'job', 'released');
    return true;
  }

  /** Realtime progress pushed by the content script. Throttled persistence. */
  async function recordEvent(ev) {
    await load();
    const key = ev && (ev.jobKey || ev.itemId); if (!key) return;
    const j = jobs.get(key); if (!j) return;
    const phase = ev.phase || j.phase;
    j.phase = phase;
    j.detail = ev.detail != null ? String(ev.detail) : j.detail;
    j.counts = ev.counts || j.counts || null;
    j.lastEventAt = now(); j.updatedAt = j.lastEventAt;
    if (phase === 'generating' && (j.state === 'submitted' || j.state === 'submitting')) j.state = 'generating';
    if (ev.log) addEvent(j, ev.log);
    persist(false);
    publish(j, 'progress', phase);
  }

  // ── circuit breaker ────────────────────────────────────────────────────────
  async function recordOutcome(ok) {
    await load();
    breaker.consecutive = ok ? 0 : breaker.consecutive + 1;
    await persist(true);
    return breakerStatus();
  }
  function breakerStatus() { return { consecutive: breaker.consecutive, limit: cfg.breakerLimit, tripped: breaker.consecutive >= cfg.breakerLimit }; }
  async function resetBreaker() { await load(); breaker.consecutive = 0; await persist(true); }

  async function snapshot() { await load(); return Array.from(jobs.values()).map(clone); }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function getConfig() { return Object.assign({}, cfg); }

  async function clearAll() { await load(); jobs.clear(); breaker = { consecutive: 0 }; await persist(true); }

  globalThis.bulkygenJobs = {
    configure, ensure, get, decide, decideFor, authorizeSubmit, refundSubmit,
    noteConfirmed, noteRecoverTry, noteProvenFailure, markCaptured, setStage,
    markNeedsAttention, markCancelled, release, recordEvent,
    recordOutcome, breakerStatus, resetBreaker, snapshot, onChange, getConfig, clearAll,
    _jobs: jobs
  };
})();
