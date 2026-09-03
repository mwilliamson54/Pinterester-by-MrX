// Part of background.js, split out for readability. Runs in the same
// service-worker global scope as background.js and the other
// background/*.js files (loaded via importScripts — NOT ES modules),
// so everything here shares state (isRunning, isPaused, etc.) with them
// exactly as it did when this was all one file.



// Inject a MAIN-world script that invokes the marked button's real React
// Make sure the content script is present in the tab before we message it.
// Prevents "Receiving end does not exist" when the page was open before the
// extension installed, or after a navigation. Idempotent: it probes a marker
// and only injects when the script is actually missing (or force=true).
// Wait until the content script on a (possibly just-navigated) tab is ready.
// Used after Grok navigation so the next prompt only fires on a live page.
async function waitForPageReady(tabId, maxAttempts = 30) {
  let attempts = 0;
  await sleep(1000);
  while (attempts < maxAttempts) {
    try {
      const res = await ext.tabs.sendMessage(tabId, { action: 'checkPage' });
      if (res && res.isSupportedPage) {
        await sleep(1500); // small settle so the UI is interactive
        return true;
      }
    } catch (e) { /* content script not ready yet */ }
    await sleep(1000);
    attempts++;
  }
  console.log('\u26A0\uFE0F Page load timeout; continuing anyway...');
  return false;
}

async function ensureTabContentScript(tabId, force) {
  if (tabId == null) return false;
  const scripting = (globalThis.chrome && globalThis.chrome.scripting) ||
    (globalThis.browser && globalThis.browser.scripting);
  if (!scripting) {
    logToExtension('warn', 'Background', 'ensureTabContentScript: scripting API unavailable');
    return false;
  }
  const EXECUTE_TIMEOUT_MS = 15000;
  try {
    if (!force) {
      try {
        const probe = await withTimeout(
          scripting.executeScript({
            target: { tabId },
            func: () => !!window.__BULKYGEN_CS_LOADED__
          }),
          EXECUTE_TIMEOUT_MS,
          'content-script probe'
        );
        if (probe && probe[0] && probe[0].result) {
          logToExtension('info', 'Background', `Content script already present on tab ${tabId}`);
          return true;
        }
      } catch (_probeErr) {
        logToExtension('warn', 'Background', `Content-script probe failed on tab ${tabId}: ${_probeErr?.message || _probeErr}; will inject.`);
      }
    }
    logToExtension('info', 'Background', `Injecting content script into tab ${tabId}...`);
    try {
      await withTimeout(
        scripting.executeScript({
          target: { tabId },
          // Keep this list in sync with manifest.json's content_scripts entry
          // for the same pages -- both must inject the exact same file set,
          // in the exact same order, for the injection-guard/namespace design
          // in content.js to work (see the comment at the top of that file).
          files: [
            'ext.js',
            'content.js',
            'content/generation-state.js',
            'content/messaging.js',
            'content/result-capture.js',
            'content/generation-core.js',
            'content/flow-dom.js',
            'content/flow-capture.js',
            'content/providers-generate.js',
            'content/media-capture.js',
            'content/unload-guard.js',
          ],
        }),
        EXECUTE_TIMEOUT_MS,
        'content-script inject'
      );
    } catch (injectErr) {
      const imsg = (injectErr && injectErr.message) || String(injectErr);
      // Re-injection of an already-initialized content.js throws on purpose.
      // Also re-probe: Chrome sometimes wraps the thrown message.
      if (/BULKYGEN_CS_ALREADY_INIT/i.test(imsg)) {
        logToExtension('info', 'Background', `Content script already initialized on tab ${tabId}`);
        return true;
      }
      try {
        const reprobe = await withTimeout(
          scripting.executeScript({
            target: { tabId },
            func: () => !!window.__BULKYGEN_CS_FULLY_INIT__
          }),
          5000,
          'content-script re-probe'
        );
        if (reprobe && reprobe[0] && reprobe[0].result) {
          logToExtension('info', 'Background', `Content script present after inject error on tab ${tabId}: ${imsg}`);
          return true;
        }
      } catch (_re) { /* fall through */ }
      throw injectErr;
    }
    await sleep(300);
    logToExtension('info', 'Background', `Content script injected into tab ${tabId}`);
    return true;
  } catch (e) {
    logToExtension('warn', 'Background', `ensureTabContentScript failed on tab ${tabId}: ${e?.message || e}`);
    console.warn('ensureTabContentScript failed:', e);
    return false;
  }
}

// onClick handler. Requires the "scripting" permission + host permission.
async function forceClickInPage(tabId) {
  if (tabId == null) return { ok: false, error: 'no tab id' };
  const scripting = (globalThis.chrome && globalThis.chrome.scripting) ||
    (globalThis.browser && globalThis.browser.scripting);
  if (!scripting) return { ok: false, error: 'scripting API unavailable' };
  try {
    const results = await scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: mainWorldForceClick
    });
    const out = results && results[0] ? results[0].result : null;
    console.log('BulkyGen Flow: force-click result', out);
    return { ok: true, result: out };
  } catch (e) {
    console.error('forceClickInPage failed:', e);
    return { ok: false, error: e.message };
  }
}

// Runs in the PAGE main world. Finds the button marked by the content script,
// walks up to its React props, and calls the real onClick handler directly.
function mainWorldForceClick() {
  const out = { found: false, calledOnClick: false, dispatched: false, handlerDepth: -1, info: '' };
  try {
    const findBtn = () => {
      // 1) Button the content script marked
      let m = document.querySelector('[data-bulkygen-submit="1"]');
      if (m) return m;
      // 2) The exact "arrow_forward" / Create icon button
      const syms = Array.from(document.querySelectorAll('i, span'));
      for (const s of syms) {
        if ((s.textContent || '').trim().toLowerCase() === 'arrow_forward') {
          const btn = s.closest('button, [role="button"]');
          if (btn) return btn;
        }
      }
      // 3) Any button whose markup contains arrow_forward
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of btns) { if (/arrow_forward/.test(btn.innerHTML || '')) return btn; }
      return null;
    };
    const el = findBtn();
    if (!el) { out.info = 'target not found'; return out; }
    out.found = true;
    out.aria = el.getAttribute ? el.getAttribute('aria-disabled') : null;

    const makeEvent = (type, node) => ({
      type, bubbles: true, cancelable: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { }, stopImmediatePropagation() { },
      isPropagationStopped: () => false,
      isDefaultPrevented() { return this.defaultPrevented; },
      persist() { }, nativeEvent: { isTrusted: true, type, bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1, view: window, clientX: 0, clientY: 0, screenX: 0, screenY: 0, pageX: 0, pageY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0.5, target: node, currentTarget: node, preventDefault() { }, stopPropagation() { }, stopImmediatePropagation() { }, composedPath: () => [node] }, currentTarget: node, target: node,
      button: 0, buttons: 1, detail: 1, view: window, isTrusted: true,
      clientX: 0, clientY: 0, pointerId: 1, pointerType: 'mouse'
    });

    // Walk up from the button to find React props carrying onClick / onPointerDown
    let node = el, depth = 0, handler = null, handlerNode = null;
    while (node && depth < 8) {
      let props = null;
      const pk = Object.keys(node).find(k => k.indexOf('__reactProps$') === 0);
      if (pk && node[pk]) props = node[pk];
      if (!props) {
        const fk = Object.keys(node).find(k => k.indexOf('__reactFiber$') === 0);
        if (fk && node[fk] && node[fk].memoizedProps) props = node[fk].memoizedProps;
      }
      if (props && (typeof props.onClick === 'function' || typeof props.onPointerDown === 'function')) {
        handler = props; handlerNode = node; out.handlerDepth = depth; break;
      }
      node = node.parentElement; depth++;
    }

    if (handler) {
      try {
        if (typeof handler.onPointerDown === 'function') handler.onPointerDown(makeEvent('pointerdown', handlerNode));
        if (typeof handler.onMouseDown === 'function') handler.onMouseDown(makeEvent('mousedown', handlerNode));
        if (typeof handler.onPointerUp === 'function') handler.onPointerUp(makeEvent('pointerup', handlerNode));
        if (typeof handler.onMouseUp === 'function') handler.onMouseUp(makeEvent('mouseup', handlerNode));
        if (typeof handler.onClick === 'function') { handler.onClick(makeEvent('click', handlerNode)); out.calledOnClick = true; }
      } catch (e) { out.info += ' handler err: ' + e.message; }
    } else {
      out.info += ' no react onClick found;';
    }

    // Genuine native click in the main world as a backup
    try {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
      const p = { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...p, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new MouseEvent('click', base));
      el.click();
      out.dispatched = true;
    } catch (e) { out.info += ' dispatch err: ' + e.message; }
  } catch (e) {
    out.info += ' fatal: ' + e.message;
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}