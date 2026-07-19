/*
 * BulkyGen background automation enabler (runs in the PAGE's own world).
 *
 * Generator SPAs (Flow / Meta / Grok / DIGEN / Gentube) pause their editor,
 * network work and render loop whenever the tab is hidden or loses focus -- so
 * prompt injection, image fetching and downloads only worked on the active tab.
 *
 * This script makes the page permanently believe it is visible AND focused, and
 * keeps its requestAnimationFrame loop running even while the tab is in the
 * background, so the WHOLE automation (inject -> generate -> fetch -> download)
 * continues when you switch tabs, windows, or apps.
 *
 * It runs at document_start in the MAIN world so it takes effect before the
 * site's own scripts read these values.
 */
(function () {
  'use strict';
  if (window.__bulkygenBgPatched) return;
  window.__bulkygenBgPatched = true;

  var def = function (obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, { configurable: true, get: function () { return value; } });
    } catch (e) { /* non-configurable; ignore */ }
  };

  // 1) Always-visible / always-focused.
  try { def(document, 'hidden', false); } catch (e) {}
  try { def(document, 'visibilityState', 'visible'); } catch (e) {}
  try { def(document, 'webkitHidden', false); } catch (e) {}
  try { def(document, 'webkitVisibilityState', 'visible'); } catch (e) {}
  try { document.hasFocus = function () { return true; }; } catch (e) {}

  // 2) Swallow the events the site uses to pause work when backgrounded.
  //    Captured at the window level before the page's own listeners run.
  var swallow = function (type) {
    try {
      window.addEventListener(type, function (e) {
        e.stopImmediatePropagation();
      }, true);
    } catch (e) { /* ignore */ }
  };
  ['visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange', 'msvisibilitychange',
   'blur', 'pagehide', 'freeze'].forEach(swallow);

  // Pretend a focus is held: if the site listens for 'focus', it still sees us
  // as focused; we never forward 'blur'.

  // 3) Keep requestAnimationFrame loops alive while hidden. The browser freezes
  //    native rAF callbacks for hidden tabs; many SPAs drive their render/state
  //    loop through rAF, so they would stall. We race the native rAF against a
  //    ~16ms timer (kept unthrottled by the extension's silent-audio keep-alive)
  //    and fire the callback exactly once per requested frame.
  try {
    var nativeRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
    var nativeCAF = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : null;
    var seq = 0;
    var pending = Object.create(null);

    window.requestAnimationFrame = function (cb) {
      var id = ++seq;
      var fired = false;
      var run = function (ts) {
        if (fired) return;
        fired = true;
        var entry = pending[id];
        if (entry && entry.timer) { clearTimeout(entry.timer); }
        delete pending[id];
        try { cb(typeof ts === 'number' ? ts : (performance && performance.now ? performance.now() : Date.now())); }
        catch (e) { /* match native: swallow */ }
      };
      var rafHandle = null;
      if (nativeRAF) { try { rafHandle = nativeRAF(run); } catch (e) {} }
      var timer = setTimeout(function () { run(performance && performance.now ? performance.now() : Date.now()); }, 16);
      pending[id] = { timer: timer, raf: rafHandle };
      return id;
    };

    window.cancelAnimationFrame = function (id) {
      var entry = pending[id];
      if (entry) {
        if (entry.timer) { clearTimeout(entry.timer); }
        if (entry.raf != null && nativeCAF) { try { nativeCAF(entry.raf); } catch (e) {} }
        delete pending[id];
      }
    };
  } catch (e) { /* leave native rAF in place on failure */ }
})();
