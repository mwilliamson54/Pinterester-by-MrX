// Bridge between the Bulk Generator tool page and the extension.
//
// Runs only on pages that declare <meta name="bulkgen-tool">. The page talks to
// this script with window.postMessage; this script relays to the background
// (background/tool-link.js) and pushes extension events back into the page.
//
//   page -> bridge   { source:'bulkgen-tool', reqId, type, payload }
//        types: hello | enqueue | control | snapshot | apiResult
//   bridge -> page   { source:'bulkgen-ext', type:'ready' | 'ack' | 'event', ... }
//
// Match patterns in manifest.json decide where this may run (file://, localhost).
// Trim them to wherever you actually host the tool.
(function () {
  if (window.__BULKGEN_BRIDGE__) return;
  if (!document.querySelector('meta[name="bulkgen-tool"]')) return;
  window.__BULKGEN_BRIDGE__ = true;

  const rt = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : null;
  if (!rt) return;
  const origin = location.origin === 'null' ? '*' : location.origin;
  const toPage = (msg) => window.postMessage(Object.assign({ source: 'bulkgen-ext' }, msg), origin);

  const ACTIONS = { hello: 'toolHello', enqueue: 'toolEnqueue', control: 'toolControl', snapshot: 'jobSnapshot', apiResult: 'toolApiResult' };

  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== 'bulkgen-tool' || !ACTIONS[d.type]) return;
    let resp;
    try {
      resp = await rt.sendMessage(Object.assign({}, d.payload || {}, { action: ACTIONS[d.type] }));
    } catch (err) {
      resp = { ok: false, reason: 'extension unreachable: ' + (err && err.message) };
    }
    toPage({ type: 'ack', reqId: d.reqId, reply: resp === undefined ? { ok: false, reason: 'no reply' } : resp });
  });

  rt.onMessage.addListener((m) => {
    if (m && m.action === 'toolEvent') toPage({ type: 'event', event: m.event });
    return false;
  });

  toPage({ type: 'ready', version: rt.getManifest ? rt.getManifest().version : null });
})();
