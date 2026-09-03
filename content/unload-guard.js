// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;



// ── Unload guard ─────────────────────────────────────────────────────────────
// When the Flow SPA navigates to another route (or the tab is closed) while a
// generation is in-flight, Chrome tears down this content-script context
// immediately. The background's __resultWaiters and pipeline's _pendingResults
// would then silently wait out their full 300-second timeout with zero activity
// unless we notify them here. We fire a best-effort `generationResult` failure
// message so both fail fast and the pipeline retries in ~2 seconds instead of
// 5 minutes.
//
// `pagehide` fires even for bfcache (back-forward cache) navigations in Chrome,
// whereas `beforeunload` only fires on a real unload. We listen to both for
// maximum coverage, but gate on NS.activeGenerationItemId so we only signal when
// there is actually something in flight.
function __onPageUnload() {
  const itemId = NS.activeGenerationItemId;
  if (!itemId) return; // nothing in flight — nothing to do
  NS.clientLog('warn', 'ContentScript', `Page unloading mid-generation (itemId=${itemId}) — sending failure signal so pipeline retries immediately.`);
  try {
    (globalThis.chrome || NS.ext).runtime.sendMessage({
      action: 'generationResult',
      itemId,
      result: { success: false, error: 'Content script context was destroyed mid-generation (page navigation or reload)' }
    });
  } catch (e) { /* context already gone — background will detect via heartbeat */ }
}
window.addEventListener('pagehide', __onPageUnload, { capture: true });
window.addEventListener('beforeunload', __onPageUnload, { capture: true });
})();
