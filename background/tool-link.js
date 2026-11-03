// Part of background.js, split out for readability. Runs in the same
// service-worker global scope as background.js and the other
// background/*.js files (loaded via importScripts — NOT ES modules).
//
// Cross-linking hub. Everything that lets the extension "see" what the Flow page
// is doing, and lets the tool page / popup watch and steer it:
//
//   content script  --jobAuthorizeSubmit-->  ledger   (credit gate, write-ahead)
//   content script  --jobEvent----------->   ledger   (realtime phase + counts)
//   ledger          --jobProgress-------->   popup    (live monitor)
//   ledger / loop   --toolEvent---------->   tool tab  (via content/tool-bridge.js)
//   tool tab        --toolEnqueue / toolControl-->  this file
//
// This file only ROUTES. All credit decisions live in modules/job-ledger.js.

(function () {
  const toolTabs = new Set();
  const J = () => globalThis.bulkygenJobs;

  function pushToTools(event) {
    for (const tabId of Array.from(toolTabs)) {
      try {
        const p = ext.tabs.sendMessage(tabId, { action: 'toolEvent', event });
        if (p && p.catch) p.catch(() => toolTabs.delete(tabId));
      } catch (e) { toolTabs.delete(tabId); }
    }
  }

  function runSnapshot() {
    return {
      isRunning: !!isRunning,
      isPaused: !!isPaused,
      status: getGenerationStatus(),
      breaker: J() ? J().breakerStatus() : null,
      config: J() ? J().getConfig() : null,
      tabId: currentTabId
    };
  }

  function publishRun(state, info) {
    pushToTools({ type: 'run', state, ...runSnapshot(), info: info || {} });
  }

  function publishResult(item, images) {
    if (!item || !item._toolJobId) return;
    pushToTools({
      type: 'result',
      jobId: item._toolJobId,
      images: (images || []).map(im => ({ dataUrl: im.imageData, meta: im.meta || null }))
    });
  }

  // Keep tool tabs in sync with every ledger change for tool-originated jobs.
  function wireLedger() {
    if (!J() || wireLedger.done) return;
    wireLedger.done = true;
    J().onChange(({ type, job, note }) => {
      if (job && job.source === 'tool') pushToTools({ type: 'job', kind: type, note, job });
    });
  }

  // ── extension -> tool "api engine" commands (Gemini-hosted tool) ────────────
  const pendingApi = new Map();

  function isToolTab(tabId) { return toolTabs.has(tabId); }

  /**
   * Make sure the tool page in this tab is linked. The service worker forgets its
   * tab list whenever it restarts, and the page's bridge may never have been
   * injected into a sandboxed Canvas iframe, so: (1) inject the bridge into every
   * frame of the tab, (2) ask the page to announce itself, (3) wait briefly.
   */
  async function ensureLinked(tabId, waitMs) {
    if (toolTabs.has(tabId)) return true;
    try {
      const scripting = (globalThis.chrome && globalThis.chrome.scripting) || (globalThis.browser && globalThis.browser.scripting);
      if (scripting) await scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/tool-bridge.js'] });
    } catch (e) { /* frames we have no permission for are skipped; ping below tells us */ }
    const deadline = Date.now() + (waitMs || 5000);
    while (Date.now() < deadline) {
      try { const p = ext.tabs.sendMessage(tabId, { action: 'toolEvent', event: { type: 'ping' } }); if (p && p.catch) p.catch(() => { }); } catch (e) { /* ignore */ }
      await new Promise(r => setTimeout(r, 400));
      if (toolTabs.has(tabId)) return true;
    }
    return false;
  }
  function firstToolTab() { const it = toolTabs.values().next(); return it.done ? null : it.value; }

  /** Ask the tool page to run its Gemini API call for one job and wait for the answer. */
  function runApi(tabId, job, timeoutMs) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        pendingApi.delete(job.id);
        resolve({ ok: false, timeout: true, error: `tool page did not answer within ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      pendingApi.set(job.id, (r) => { clearTimeout(t); resolve(r); });
      try {
        const p = ext.tabs.sendMessage(tabId, { action: 'toolEvent', event: { type: 'command', cmd: 'api_generate', job } });
        if (p && p.catch) p.catch((e) => {
          if (pendingApi.has(job.id)) { pendingApi.delete(job.id); clearTimeout(t); resolve({ ok: false, unreachable: true, error: 'tool page unreachable: ' + (e && e.message) }); }
        });
      } catch (e) { pendingApi.delete(job.id); clearTimeout(t); resolve({ ok: false, unreachable: true, error: String(e && e.message || e) }); }
    });
  }

  async function toolEnqueue(message) {
    const input = Array.isArray(message.jobs) ? message.jobs : [];
    const queue = input
      .map(j => ({
        id: String(j.id),
        prompt: String(j.prompt || '').trim(),
        status: 'pending',
        aspectRatio: j.aspectRatio || null,
        _toolJobId: String(j.id),
        _toolRunId: String(message.runId || '')
      }))
      .filter(q => q.id && q.prompt);
    if (!queue.length) return { ok: false, reason: 'no_jobs' };
    if (loopActive || isRunning) return { ok: false, reason: 'busy', ...runSnapshot() };

    wireLedger();
    for (const q of queue) {
      await J().ensure(q.id, { prompt: q.prompt, aspectRatio: q.aspectRatio, itemId: q.id, source: 'tool' });
    }
    await ext.storage.local.set({ queue, currentIndex: 0, isPaused: false });
    isPaused = false;
    const ack = tryStartGeneration();
    if (!ack || ack.started !== true) {
      return { ok: false, reason: (ack && ack.reason) || 'not_started', ...runSnapshot() };
    }
    return { ok: true, count: queue.length, runId: message.runId || null, ...runSnapshot() };
  }

  async function toolControl(message) {
    const cmd = message.cmd;
    if (cmd === 'pause') {
      isPaused = true; await ext.storage.local.set({ isPaused: true });
      publishRun('paused'); return { ok: true, ...runSnapshot() };
    }
    if (cmd === 'resume') {
      isPaused = false; await ext.storage.local.set({ isPaused: false });
      publishRun('running'); return { ok: true, ...runSnapshot() };
    }
    if (cmd === 'stop') {
      abortGenerationLoop('stopped from tool page');
      const jobs = await J().snapshot();
      for (const j of jobs) {
        if (j.source === 'tool' && !j.captured && ['queued', 'submitting'].includes(j.state)) await J().markCancelled(j.key);
      }
      publishRun('idle'); return { ok: true, ...runSnapshot() };
    }
    if (cmd === 'release') {
      if (!message.jobId) return { ok: false, reason: 'no_job' };
      const ok = await J().release(String(message.jobId));
      return { ok };
    }
    if (cmd === 'reset_breaker') { await J().resetBreaker(); return { ok: true, ...runSnapshot() }; }
    if (cmd === 'probe') return await probeFlowTab();
    return { ok: false, reason: 'unknown_cmd' };
  }

  async function probeFlowTab() {
    try {
      let tabId = currentTabId;
      if (tabId == null) {
        const d = await ext.storage.local.get(['genTabId']);
        tabId = d.genTabId;
      }
      if (tabId == null) {
        const all = await ext.tabs.query({});
        const t = all.find(x => isSupportedTabUrl(x.url));
        tabId = t && t.id;
      }
      if (tabId == null) return { ok: false, reason: 'no_flow_tab' };
      const r = await withTimeout(ext.tabs.sendMessage(tabId, { action: 'flowProbe' }), 4000, 'flowProbe');
      return Object.assign({ ok: true, tabId }, r || {});
    } catch (e) {
      return { ok: false, reason: e && e.message || String(e) };
    }
  }

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const a = message && message.action;
    if (!a) return false;
    const led = J();

    switch (a) {
      // ── credit gate + realtime events from the content script ──
      case 'jobAuthorizeSubmit':
        if (!led) { sendResponse({ allowed: false, reason: 'job ledger module not loaded' }); return false; }
        led.authorizeSubmit(message.jobKey, message.itemId, { prompt: message.prompt, aspectRatio: message.aspectRatio })
          .then(sendResponse, (e) => sendResponse({ allowed: false, reason: 'ledger error: ' + (e && e.message) }));
        return true;
      case 'jobRefundSubmit':
        if (led) led.refundSubmit(message.jobKey, message.reason).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
        else sendResponse({ ok: false });
        return true;
      case 'jobConfirmSubmit':
        if (led) led.noteConfirmed(message.jobKey, message.by).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
        else sendResponse({ ok: false });
        return true;
      case 'jobEvent':
        if (led) led.recordEvent(message).catch(() => { });
        return false;

      // ── popup / tool queries ──
      case 'jobSnapshot':
        if (!led) { sendResponse({ jobs: [], ...runSnapshot() }); return false; }
        led.snapshot().then(jobs => sendResponse({ jobs, ...runSnapshot() }), () => sendResponse({ jobs: [] }));
        return true;
      case 'jobRelease':
        if (led) led.release(message.jobKey).then(ok => sendResponse({ ok }), () => sendResponse({ ok: false }));
        else sendResponse({ ok: false });
        return true;
      case 'jobResetBreaker':
        if (led) led.resetBreaker().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
        else sendResponse({ ok: false });
        return true;
      case 'jobProbe':
        probeFlowTab().then(sendResponse);
        return true;

      // ── tool page (through content/tool-bridge.js) ──
      case 'toolHello':
        if (sender && sender.tab) toolTabs.add(sender.tab.id);
        wireLedger();
        (async () => {
          const jobs = led ? (await led.snapshot()).filter(j => j.source === 'tool') : [];
          sendResponse({ ok: true, jobs, ...runSnapshot() });
        })();
        return true;
      case 'toolEnqueue':
        if (sender && sender.tab) toolTabs.add(sender.tab.id);
        toolEnqueue(message).then(sendResponse, (e) => sendResponse({ ok: false, reason: e && e.message }));
        return true;
      case 'toolApiResult': {
        const cb = pendingApi.get(String(message.jobId));
        if (cb) { pendingApi.delete(String(message.jobId)); cb(message); }
        sendResponse({ ok: !!cb });
        return false;
      }
      case 'toolControl':
        toolControl(message).then(sendResponse, (e) => sendResponse({ ok: false, reason: e && e.message }));
        return true;
      default:
        return false;
    }
  });


  globalThis.bulkygenToolLink = { publishRun, publishResult, push: pushToTools, probeFlowTab, isToolTab, firstToolTab, ensureLinked, runApi };
  wireLedger();
})();
