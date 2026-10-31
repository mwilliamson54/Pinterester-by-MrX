// Live job monitor for the popup / side panel. Read-mostly: it shows what the
// job ledger knows (state, submit count vs budget, last phase, page counts) and
// lets you probe the Flow tab or release a blocked job. No styling dependency
// on popup.css; it injects its own minimal styles.
(function () {
  const rt = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : null;
  if (!rt) return;

  const STATE_ORDER = ['needs_attention', 'failed', 'generating', 'submitted', 'submitting', 'processing', 'captured', 'queued', 'cancelled', 'done'];
  const jobs = new Map();
  let run = {};
  let probe = null;

  const style = document.createElement('style');
  style.textContent = `
    #liveMonitor{font:12px system-ui,sans-serif;border:1px solid #8884;border-radius:6px;margin:8px;padding:6px}
    #liveMonitor h4{margin:0 0 4px;font-size:12px;display:flex;justify-content:space-between;align-items:center}
    #liveMonitor table{width:100%;border-collapse:collapse}
    #liveMonitor td,#liveMonitor th{padding:2px 4px;border-bottom:1px solid #8882;text-align:left;vertical-align:top}
    #liveMonitor .s-needs_attention,#liveMonitor .s-failed{color:#c0392b;font-weight:600}
    #liveMonitor .s-captured,#liveMonitor .s-done{color:#1e8449}
    #liveMonitor .s-generating,#liveMonitor .s-submitted,#liveMonitor .s-submitting{color:#b9770e}
    #liveMonitor button{font-size:11px;padding:1px 6px;cursor:pointer}
    #liveMonitor .probe{margin-top:4px;opacity:.85;white-space:pre-wrap}
  `;
  document.head.appendChild(style);

  let root = document.getElementById('liveMonitor');
  if (!root) {
    root = document.createElement('div');
    root.id = 'liveMonitor';
    document.body.insertBefore(root, document.body.firstChild);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const age = (t) => { if (!t) return ''; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? s + 's' : Math.round(s / 60) + 'm'; };

  function render() {
    const list = Array.from(jobs.values()).sort((a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 12);
    const max = (run.config && run.config.maxSubmitsPerJob) || 2;
    const br = run.breaker ? `breaker ${run.breaker.consecutive}/${run.breaker.limit}` : '';
    root.innerHTML = `
      <h4><span>Live jobs &middot; ${run.isRunning ? (run.isPaused ? 'paused' : 'running') : 'idle'} ${esc(br)}</span>
      <span><button data-a="probe">Probe Flow tab</button> <button data-a="breaker">Reset breaker</button></span></h4>
      ${list.length ? `<table><tr><th>Job</th><th>State</th><th>Sub</th><th>Phase</th><th>Age</th><th></th></tr>${list.map(j => `
        <tr title="${esc(j.error || j.detail || '')}">
          <td>${esc(String(j.key).slice(0, 18))}</td>
          <td class="s-${esc(j.state)}">${esc(j.state)}</td>
          <td>${j.submitCount}/${max}</td>
          <td>${esc(j.phase)}${j.counts ? ` <small>(t${j.counts.tiles}/i${j.counts.imgs}/e${j.counts.errors}${j.counts.generating ? '/gen' : ''})</small>` : ''}</td>
          <td>${age(j.lastEventAt || j.updatedAt)}</td>
          <td>${['needs_attention', 'failed'].includes(j.state) ? `<button data-a="release" data-k="${esc(j.key)}" title="Allows a NEW paid submit">Release</button>` : ''}</td>
        </tr>`).join('')}</table>` : '<div>No jobs yet.</div>'}
      ${probe ? `<div class="probe">${esc(JSON.stringify(probe))}</div>` : ''}`;
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'probe') { probe = await rt.sendMessage({ action: 'jobProbe' }); render(); }
    if (a === 'breaker') { await rt.sendMessage({ action: 'jobResetBreaker' }); refresh(); }
    if (a === 'release') {
      if (!confirm('Release this job? The next run may submit it again and spend credits.')) return;
      await rt.sendMessage({ action: 'jobRelease', jobKey: b.dataset.k }); refresh();
    }
  });

  rt.onMessage.addListener((m) => {
    if (m && m.action === 'jobProgress' && m.job) { jobs.set(m.job.key, m.job); render(); }
    if (m && m.action === 'pipelineHalted') { probe = { halted: m.reason, consecutive: m.consecutive }; render(); }
  });

  async function refresh() {
    try {
      const r = await rt.sendMessage({ action: 'jobSnapshot' });
      if (r) { run = r; jobs.clear(); (r.jobs || []).forEach(j => jobs.set(j.key, j)); render(); }
    } catch (e) { /* background asleep; next event refreshes */ }
  }
  refresh();
  setInterval(refresh, 5000);
  setInterval(render, 1000);
})();
