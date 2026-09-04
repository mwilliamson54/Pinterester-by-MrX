// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;



// ─────────────────────────────────────────────────────────────────────────
// Flow tile identity
// ─────────────────────────────────────────────────────────────────────────
// Find the tile container for a given result image (Flow tags each result
// tile with a stable data-tile-id attribute, unlike its buttons/menus). Used
// to tell genuinely new results apart from old tiles that scroll/virtualize
// back into view (see NS.shouldRejectFlowTileForRun below).
function findFlowTileContainer(img) {
  // A generic parent is not a safe fallback: it can contain controls for a
  // different tile when Flow virtualizes or reorders the project grid.
  return img ? img.closest('[data-tile-id]') : null;
}

function getFlowTileId(img) {
  return findFlowTileContainer(img)?.getAttribute('data-tile-id') || null;
}

// ─────────────────────────────────────────────────────────────────────────
// Flow aspect ratio selection
// ─────────────────────────────────────────────────────────────────────────
// Maps the aspect-ratio labels we accept from Supabase ("16:9", "4:3", "1:1",
// "3:4", "9:16") to the Material Symbols ligature Flow renders for that
// option (e.g. "crop_16_9"). This is used both to read which ratio is
// CURRENTLY selected (from the settings-trigger button's icon) and to find
// the matching tab inside the ratio popover — it's more stable than Radix's
// auto-generated ids/classes, which change between page loads/builds.
const FLOW_ASPECT_RATIO_ICONS = {
  '16:9': 'crop_16_9',
  '4:3': 'crop_landscape',
  '1:1': 'crop_square',
  '3:4': 'crop_portrait',
  '9:16': 'crop_9_16'
};

// The settings/model trigger button (shows e.g. "🍌 Nano Banana 2  [icon] 1x")
// that opens the popover containing Image/Video, aspect ratio, and 1x-4x
// tabs. Identified by aria-haspopup="menu" plus an <i> icon whose ligature is
// one of the known aspect-ratio icons, rather than by id/class.
function findFlowRatioTriggerButton() {
  const buttons = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
  for (const btn of buttons) {
    const icon = Array.from(btn.querySelectorAll('i'))
      .find(i => Object.values(FLOW_ASPECT_RATIO_ICONS).includes((i.textContent || '').trim()));
    if (icon) return { button: btn, icon };
  }
  return null;
}

// Read the currently-selected aspect ratio from the trigger button's icon.
// Returns null if the button/icon can't be found or doesn't match a known ratio.
function getFlowCurrentAspectRatio() {
  const found = findFlowRatioTriggerButton();
  if (!found) return null;
  const iconText = (found.icon.textContent || '').trim();
  const entry = Object.entries(FLOW_ASPECT_RATIO_ICONS).find(([, ic]) => ic === iconText);
  return entry ? entry[0] : null;
}

// Inside the OPEN ratio popover, find the tab button for a given ratio
// (e.g. "16:9"), matched by its own icon ligature.
function findFlowRatioTabButton(ratio) {
  const iconName = FLOW_ASPECT_RATIO_ICONS[ratio];
  if (!iconName) return null;
  const menu = document.querySelector('[data-radix-menu-content][data-state="open"]') ||
    document.querySelector('[role="menu"][data-state="open"]') ||
    document; // fall back to whole doc in case the open-state attr differs
  const tabs = Array.from(menu.querySelectorAll('button[role="tab"]'));
  for (const tab of tabs) {
    const icon = tab.querySelector('i');
    if (icon && (icon.textContent || '').trim() === iconName) return tab;
  }
  return null;
}

// Make sure Flow's aspect-ratio selector matches `targetRatio` before we
// submit. No-op if it's already set correctly. Otherwise opens the settings
// popover, clicks the matching ratio tab, confirms the change, and closes
// the popover again so it doesn't sit on top of the composer/generate button.
async function ensureFlowAspectRatio(targetRatio) {
  if (!targetRatio) return { changed: false, reason: 'no ratio requested' };
  const normalized = String(targetRatio).trim();
  if (!FLOW_ASPECT_RATIO_ICONS[normalized]) {
    console.warn('BulkyGen Flow: unrecognized aspect ratio requested:', targetRatio);
    NS.clientLog('warn', 'Flow', `Unrecognized aspect ratio "${targetRatio}" — expected one of 16:9, 4:3, 1:1, 3:4, 9:16. Leaving ratio unchanged.`);
    return { changed: false, reason: 'unrecognized ratio' };
  }

  const current = getFlowCurrentAspectRatio();
  if (current === normalized) {
    console.log('BulkyGen Flow: aspect ratio already set to', normalized);
    return { changed: false, reason: 'already set' };
  }

  const trigger = findFlowRatioTriggerButton();
  if (!trigger) {
    console.warn('BulkyGen Flow: could not find the aspect-ratio trigger button');
    NS.clientLog('warn', 'Flow', 'Could not find the aspect-ratio trigger button — Flow\'s markup may have changed.');
    return { changed: false, reason: 'trigger not found' };
  }

  console.log(`BulkyGen Flow: switching aspect ratio ${current || '?'} -> ${normalized}`);

  // Open the settings popover. Flow ignores plain synthetic clicks on these
  // React-controlled buttons, so drive the real onClick from the main world
  // (same trick used for the generate button — see forceClickViaBackground).
  await forceClickViaBackground(trigger.button);

  let tabBtn = null;
  for (let i = 0; i < 20 && !tabBtn; i++) {
    await NS.waitUnthrottled(100);
    tabBtn = findFlowRatioTabButton(normalized);
  }

  if (!tabBtn) {
    console.warn('BulkyGen Flow: aspect ratio popover did not open, or no tab found for', normalized);
    NS.clientLog('warn', 'Flow', `Aspect ratio popover did not open (or tab not found) for "${normalized}".`);
    pressKey(document.body, 'Escape', {});
    return { changed: false, reason: 'tab not found' };
  }

  await forceClickViaBackground(tabBtn);

  // Confirm the trigger's icon actually updated to the new ratio.
  let confirmed = false;
  for (let i = 0; i < 20; i++) {
    await NS.waitUnthrottled(100);
    if (getFlowCurrentAspectRatio() === normalized) { confirmed = true; break; }
  }

  // Selecting a tab does not auto-close this popover (it's not a menuitem),
  // so close it ourselves: Escape first, then a fallback re-click of the
  // trigger if it's somehow still open.
  pressKey(document.body, 'Escape', {});
  await NS.waitUnthrottled(150);
  const stillOpen = trigger.button.getAttribute('aria-expanded') === 'true' ||
    trigger.button.getAttribute('data-state') === 'open';
  if (stillOpen) {
    await forceClickViaBackground(trigger.button);
    await NS.waitUnthrottled(100);
  }

  if (!confirmed) {
    console.warn('BulkyGen Flow: clicked ratio tab for', normalized, 'but could not confirm the trigger icon updated');
    NS.clientLog('warn', 'Flow', `Clicked the "${normalized}" ratio tab but couldn't confirm it took effect.`);
  } else {
    console.log('BulkyGen Flow: aspect ratio set to', normalized);
    NS.clientLog('info', 'Flow', `Aspect ratio set to ${normalized}.`);
  }
  return { changed: confirmed, reason: confirmed ? 'ok' : 'unconfirmed' };
}

async function submitFlowPrompt(prompt, itemId, aspectRatio) {
  return NS.runExclusiveGeneration(() => submitFlowPromptInternal(prompt, itemId, aspectRatio));
}

async function submitFlowPromptInternal(prompt, itemId, aspectRatio) {
  if (NS.PROVIDER !== 'flow') {
    NS.clientLog('error', 'Flow', `submitFlowPrompt called but detected provider is "${NS.PROVIDER}", not "flow" — the page BulkyGen is running on doesn't match a Flow project URL.`);
    throw new Error('Flow submit requested on non-Flow page');
  }

  NS.ensureKeepAlive();
  NS.activeGenerationItemId = itemId || null;

  try {
    console.log('BulkyGen Flow: submitFlowPrompt called, prompt:', prompt.substring(0, 40) + '...');
    NS.clientLog('info', 'Flow', `submitFlowPrompt called for "${prompt.substring(0, 60)}..."`);

    const uiReady = await NS.waitForProviderUI();
    if (!uiReady) {
      NS.clientLog('warn', 'Flow', 'NS.waitForProviderUI() reported not ready (no prompt textarea detected on the page).');
      throw new Error('Flow UI not ready. Make sure the prompt field is visible on the page.');
    }

    const editor = findFlowComposer();
    if (!editor) {
      NS.clientLog('error', 'Flow', 'Could not find the Flow prompt box (findFlowComposer() found no visible contenteditable/textarea) — nothing was typed. Flow\'s composer markup may have changed.');
      throw new Error('Could not find the Flow prompt box');
    }
    console.log('BulkyGen Flow: Found composer', editor.tagName, editor.className);

    // --- Make sure the requested aspect ratio is selected BEFORE we type the
    // prompt (this can open/close a popover and briefly steal focus, so do it
    // first rather than after the composer already has text in it) ---
    if (aspectRatio) {
      try {
        await ensureFlowAspectRatio(aspectRatio);
      } catch (e) {
        console.warn('BulkyGen Flow: ensureFlowAspectRatio threw:', e?.message || e);
        NS.clientLog('warn', 'Flow', `Aspect ratio selection failed: ${e?.message || e}`);
      }
    }

    // "Before" snapshot: capture both loaded image keys AND every
    // data-tile-id in the DOM. Flow's virtualized grid removes/unloads
    // <img> elements for tiles scrolled out of view, but keeps the tile
    // wrapper with its stable data-tile-id attribute in the DOM. If we
    // only snapshot loaded images, a scroll mid-generation causes old
    // tiles to lazy-load and appear "new" — associating the wrong image
    // with this prompt. Snapshotting tile IDs catches those tiles even
    // when their <img> hasn't loaded yet.
    const beforeKeys = new Set();
    const beforeTileIds = new Set();
    NS.collectResultElements()
      .filter(el => {
        if (el.tagName !== 'IMG') return false;
        const src = el.currentSrc || el.src || '';
        if (!src || !el.complete) return false;
        const w = el.naturalWidth || el.width || 0;
        const h = el.naturalHeight || el.height || 0;
        return w >= 256 && h >= 256;
      })
      .forEach(el => beforeKeys.add(NS.elementKey(el)));
    for (const k of NS.__capturedResultKeys) beforeKeys.add(k);
    // Snapshot ALL tile IDs in the DOM — even tiles whose images haven't
    // loaded yet (scrolled out of view, placeholder state, etc.). This is
    // the primary defense against scroll-induced lazy-load false positives.
    document.querySelectorAll('[data-tile-id]').forEach(tile => {
      const id = tile.getAttribute('data-tile-id');
      if (id) beforeTileIds.add(id);
    });
    const flowRunIdentity = NS.createFlowRunIdentity(beforeTileIds);

    // Flag this as OUR scroll, not the user's, before it fires -- otherwise
    // the tile-identity guard above can reject the very tile this submission
    // is about to create (see markFlowProgrammaticScroll() in generation-core.js).
    NS.markFlowProgrammaticScroll();
    editor.scrollIntoView({ behavior: 'instant', block: 'center' });
    await NS.waitUnthrottled(150);

    // --- Inject the prompt and make sure Flow actually registers it ---
    const injected = await injectFlowPrompt(editor, prompt);
    console.log('BulkyGen Flow: injected (registered=' + injected.registered + '):', (injected.text || '').substring(0, 60));
    if (!injected.text) {
      NS.clientLog('error', 'Flow', 'Failed to inject the prompt into the Flow composer — paste/beforeinput dispatch did not put any text in the editor.');
      throw new Error('Failed to inject the prompt into the Flow composer');
    }
    if (!injected.registered) {
      NS.clientLog('warn', 'Flow', 'Prompt text was inserted but the generate button never registered as ready (findFlowSubmitButton heuristics may not match the current page markup).');
    }
    await NS.waitUnthrottled(250);

    // --- Click the generate (arrow) button once it is enabled ---
    const submitted = await clickFlowGenerate(editor, prompt);
    console.log('BulkyGen Flow: submitted =', submitted);
    if (!submitted) {
      NS.clientLog('warn', 'Flow', 'clickFlowGenerate() did not confirm the generate button was clicked.');
    }

    // --- Wait for ALL generated images and capture them (x2 / x4 -> multiple) ---
    const images = [];
    const meta = { provider: 'flow', itemId: itemId ?? null, type: 'image' };
    try {
      const expected = NS.getFlowExpectedCount();
      console.log('BulkyGen Flow: expecting up to ' + expected + ' image(s)');
      const resultImgs = await NS.waitForFlowResults(beforeKeys, flowRunIdentity, expected, 120000);
      console.log('BulkyGen Flow: detected ' + resultImgs.length + ' new image(s)');
      for (const img of resultImgs) {
        const src = img.currentSrc || img.src || '';
        if (!src) continue;
        try {
          const data = await NS.getImageAsBase64(src, img);

          if (data) {
            if (NS.__capturedDataUrls.has(data)) {
              console.log('BulkyGen Flow: skipping duplicate of an already-captured image');
              continue;
            }
            NS.__capturedResultKeys.add(NS.elementKey(img));
            NS.__capturedResultSrcs.add(src);
            NS.__capturedDataUrls.add(data);
            images.push({
              imageData: data,
              meta: {
                ...meta,
                src,
                width: img.naturalWidth || img.width || 0,
                height: img.naturalHeight || img.height || 0
              }
            });
          }
        } catch (capErr) {
          console.log('BulkyGen Flow: image capture failed:', capErr.message);
        }
      }
      if (resultImgs.length === 0) {
        console.log('BulkyGen Flow: no new image detected in time (prompt was still submitted)');
        NS.clientLog('warn', 'Flow', 'No new image detected within the timeout window — prompt was submitted but nothing was captured. Check the "Tile identity guard rejected" warnings above: if present for every candidate, Flow\'s DOM markup for result tiles has likely changed (missing/renamed data-tile-id).');
      }
    } catch (waitErr) {
      console.log('BulkyGen Flow: result wait error:', waitErr.message);
    }

    return {
      success: true,
      imageData: images.length ? images[0].imageData : null,
      multipleImages: images,
      itemId: itemId ?? null,
      meta: { ...meta, captured: images.length, submitted: submitted, registered: injected.registered }
    };
  } finally {
    NS.activeGenerationItemId = null;
    NS.releaseKeepAlive();
  }
}

// Locate the Google Flow Slate.js composer (contenteditable, not a textarea)
function findFlowComposer() {
  const selectors = [
    '[data-slate-editor="true"][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][aria-multiline="true"]',
    '[contenteditable="true"]',
    'textarea'
  ];
  for (const sel of selectors) {
    const els = Array.from(document.querySelectorAll(sel));
    const visible = els.find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (visible) return visible;
  }
  return null;
}

// Put a collapsed caret at the end of the editor and focus it
function focusEditorCaret(editor) {
  try {
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* ignore */ }
}

// Select all + delete everything currently in the editor
function clearEditor(editor) {
  try {
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false, null);
  } catch { /* ignore */ }
}

// A Flow button is "ready" when it is neither disabled nor aria-disabled
function isFlowButtonReady(btn) {
  if (!btn) return false;
  if (btn.disabled) return false;
  const ad = btn.getAttribute ? btn.getAttribute('aria-disabled') : null;
  return ad !== 'true' && ad !== '';
}

// Inject text into the Slate.js editor WITHOUT mutating its DOM directly.
// Google Flow uses Slate.js; manual DOM edits (execCommand / textContent /
// removeChild via range delete) corrupt Slate's model and crash React with a
// "Failed to execute 'removeChild'" NotFoundError. We only drive the native
// paste / beforeinput pipelines so Slate updates its OWN model + DOM together.
async function injectFlowPrompt(editor, text) {
  const probe = text.trim().substring(0, Math.min(12, text.trim().length));
  const domHasText = () => (editor.innerText || editor.textContent || '').includes(probe);
  const registered = () => isFlowButtonReady(findFlowSubmitButton(editor)) && domHasText();

  // Focus + select existing content so the insert REPLACES it (no manual delete).
  // Selecting is read-only for the DOM, so it does not corrupt Slate.
  const selectExisting = () => {
    try {
      editor.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      const cur = (editor.innerText || editor.textContent || '').trim();
      if (!cur) range.collapse(false); // empty editor -> just place caret
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* ignore */ }
  };

  // Strategy 1: a real paste event (mirrors the manual "paste the prompt" flow)
  const pasteDispatch = () => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    let evt;
    try {
      evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    } catch (e) {
      evt = new Event('paste', { bubbles: true, cancelable: true });
      try { Object.defineProperty(evt, 'clipboardData', { value: dt }); } catch { /* ignore */ }
    }
    editor.dispatchEvent(evt);
  };

  // Strategy 2: native beforeinput insertText (Slate replaces the selection)
  const beforeInputDispatch = () => {
    editor.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text
    }));
  };

  for (const dispatch of [pasteDispatch, beforeInputDispatch]) {
    selectExisting();
    await NS.waitUnthrottled(40); // let Slate sync its selection from the DOM
    try { dispatch(); } catch { /* ignore */ }
    // Wait for Slate to update its model + re-render (button enables)
    for (let i = 0; i < 9; i++) {
      await NS.waitUnthrottled(60);
      if (registered()) {
        return { registered: true, text: (editor.innerText || editor.textContent || '').trim() };
      }
    }
  }
  return { registered: false, text: (editor.innerText || editor.textContent || '').trim() };
}

// Find the Flow generate / arrow ("Create") button
function findFlowSubmitButton(editor) {
  const isBad = (text, aria) => {
    const s = text + ' ' + aria;
    return s.includes('attach') || s.includes('upload') || s.includes('settings') ||
      s.includes('menu') || s.includes('close') || s.includes('model') ||
      s.includes('agent') || s.includes('mic') || s.includes('delete') ||
      s.includes('remove') || s.includes('back');
  };
  const isGood = (text, aria) => {
    const s = text + ' ' + aria;
    return s.includes('generate') || s.includes('create') ||
      s.includes('send') || s.includes('submit') || s.includes('run');
  };
  const er = editor.getBoundingClientRect();
  const dist = (btn) => {
    const r = btn.getBoundingClientRect();
    const dx = (r.left + r.width / 2) - er.right;
    const dy = (r.top + r.height / 2) - (er.top + er.height / 2);
    return Math.hypot(dx, dy);
  };

  const all = Array.from(document.querySelectorAll('button, [role="button"]'));

  // Pass 1: buttons labelled like generate/create, or carrying the arrow_forward icon
  const labelled = all.filter(btn => {
    if (btn === editor) return false;
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const text = NS.normalizeText(btn.textContent || '');
    const aria = NS.normalizeText(btn.getAttribute('aria-label') || '');
    if (isBad(text, aria)) return false;
    return isGood(text, aria) || /arrow_forward/.test(btn.innerHTML || '');
  });
  if (labelled.length) {
    labelled.sort((a, b) => dist(a) - dist(b));
    return labelled[0];
  }

  // Pass 2: nearest small icon/svg button to the editor
  let best = null, bestDist = Infinity;
  all.forEach(btn => {
    if (btn === editor) return;
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.width > 120 || r.height > 120) return;
    const text = NS.normalizeText(btn.textContent || '');
    const aria = NS.normalizeText(btn.getAttribute('aria-label') || '');
    if (isBad(text, aria)) return;
    if (!btn.querySelector('svg') && !btn.querySelector('i')) return;
    const d = dist(btn);
    if (d < bestDist && d < 700) { bestDist = d; best = btn; }
  });
  return best;
}

// Submit Enter with optional modifier keys (Flow may use Cmd/Ctrl+Enter)
function dispatchEnterWithMods(target, mods) {
  if (!target) return;
  const opts = Object.assign({
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true, composed: true, view: window
  }, mods || {});
  try { target.dispatchEvent(new KeyboardEvent('keydown', opts)); } catch { /* ignore */ }
  try { target.dispatchEvent(new KeyboardEvent('keypress', opts)); } catch { /* ignore */ }
  try { target.dispatchEvent(new KeyboardEvent('keyup', opts)); } catch { /* ignore */ }
}

// A realistic click: pointer + mouse sequence at the element's real coordinates,
// with a small delay between press and release (some handlers ignore instant clicks).
async function realClick(el) {
  if (!el) return;
  try { el.focus(); } catch { /* ignore */ }
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, detail: 1 };
  const pBase = { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse', width: 1, height: 1, pressure: 0.5 };
  try { el.dispatchEvent(new PointerEvent('pointerover', pBase)); } catch { /* ignore */ }
  try { el.dispatchEvent(new PointerEvent('pointerenter', pBase)); } catch { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('mouseover', base)); } catch { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('mouseenter', base)); } catch { /* ignore */ }
  try { el.dispatchEvent(new PointerEvent('pointerdown', { ...pBase, buttons: 1 })); } catch { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 })); } catch { /* ignore */ }
  await NS.waitUnthrottled(60);
  try { el.dispatchEvent(new PointerEvent('pointerup', { ...pBase, buttons: 0 })); } catch { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('mouseup', base)); } catch { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('click', base)); } catch { /* ignore */ }
  try { el.click(); } catch { /* ignore */ }
}

// Press a key (with optional modifiers) on a target element
function pressKey(target, key, mods) {
  if (!target) return;
  const code = key === ' ' ? 'Space' : key;
  const kc = key === ' ' ? 32 : (key === 'Enter' ? 13 : 0);
  const opts = Object.assign({ key, code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true, view: window }, mods || {});
  try { target.dispatchEvent(new KeyboardEvent('keydown', opts)); } catch { /* ignore */ }
  try { target.dispatchEvent(new KeyboardEvent('keypress', opts)); } catch { /* ignore */ }
  try { target.dispatchEvent(new KeyboardEvent('keyup', opts)); } catch { /* ignore */ }
}

// Ask the background service worker to invoke the button's REAL React onClick
// handler from the page's MAIN world. Content scripts run in an isolated world
// and cannot see React's handlers, and Google Flow ignores synthetic clicks from
// the content script. Running in the main world and calling onClick directly is
// the reliable way to trigger generation.
async function forceClickViaBackground(btn) {
  if (!btn) return null;
  try {
    btn.setAttribute('data-bulkygen-submit', '1');
    const res = await NS.ext.runtime.sendMessage({ action: 'flowForceClick' });
    try { console.log('BulkyGen Flow: force-click ->', JSON.stringify(res && res.result ? res.result : res)); } catch { /* ignore */ }
    return res;
  } catch (e) {
    console.log('BulkyGen Flow: force-click error:', e.message);
    return null;
  } finally {
    try { btn.removeAttribute('data-bulkygen-submit'); } catch { /* ignore */ }
  }
}


// Wait for the generate button to be enabled, then click it; verify submission
async function clickFlowGenerate(editor, prompt) {
  let btn = findFlowSubmitButton(editor);
  for (let i = 0; i < 25 && !isFlowButtonReady(btn); i++) {
    await NS.waitUnthrottled(200);
    btn = findFlowSubmitButton(editor);
  }
  if (!btn) {
    console.log('BulkyGen Flow: generate button NOT found');
    return false;
  }
  console.log('BulkyGen Flow: generate button =>', describeEl(btn));

  const probe = prompt.trim().substring(0, Math.min(12, prompt.trim().length));
  const promptText = () => (editor.innerText || editor.textContent || '').trim();
  const hadPrompt = !!probe && promptText().includes(probe);
  const baseImgCount = NS.collectResultElements().filter(el => el.tagName === 'IMG').length;

  // Submission succeeded if: prompt cleared, OR button became disabled (processing),
  // OR a new image/skeleton tile appeared.
  const submitted = () => {
    const stillThere = !!probe && promptText().includes(probe);
    const cur = findFlowSubmitButton(editor);
    const ariaNow = cur ? cur.getAttribute('aria-disabled') : null;
    const imgNow = NS.collectResultElements().filter(el => el.tagName === 'IMG').length;
    return (hadPrompt && !stillThere) || ariaNow === 'true' || imgNow > baseImgCount;
  };

  // Give Slate/React a moment to fully wire the enabled button
  await NS.waitUnthrottled(80);

  for (let attempt = 0; attempt < 5; attempt++) {
    const target = findFlowSubmitButton(editor) || btn;
    if (target) {
      NS.markFlowProgrammaticScroll();
      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      await NS.waitUnthrottled(40);
      // Strongest method: call the button's real React onClick from the main world
      await forceClickViaBackground(target);
      await NS.waitUnthrottled(180);
      if (submitted()) return true;
      // Fallback: synthetic clicks on the button, topmost element, and inner icon
      const r = target.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      await realClick(target);
      if (top && top !== target) await realClick(top);
      const inner = target.querySelector('i, span, svg');
      if (inner) await realClick(inner);
      // Buttons also activate via keyboard when focused
      try { target.focus(); } catch { /* ignore */ }
      pressKey(target, 'Enter');
      pressKey(target, ' ');
    }
    await NS.waitUnthrottled(250);
    const curBtn = findFlowSubmitButton(editor);
    console.log('BulkyGen Flow: click attempt ' + (attempt + 1) +
      ' -> connected=' + (target ? document.contains(target) : 'n/a') +
      ' aria=' + (curBtn ? curBtn.getAttribute('aria-disabled') : 'n/a') +
      ' promptStillThere=' + (!!probe && promptText().includes(probe)));
    if (submitted()) return true;
    await NS.waitUnthrottled(150);
  }

  // Last resort: keyboard submit inside the editor (plain, Ctrl+Enter, Cmd+Enter)
  editor.focus();
  pressKey(editor, 'Enter');
  await NS.waitUnthrottled(400);
  if (submitted()) return true;
  pressKey(editor, 'Enter', { ctrlKey: true });
  await NS.waitUnthrottled(400);
  if (submitted()) return true;
  pressKey(editor, 'Enter', { metaKey: true });
  await NS.waitUnthrottled(500);
  console.log('BulkyGen Flow: final -> aria=' +
    ((findFlowSubmitButton(editor) || {}).getAttribute ? findFlowSubmitButton(editor).getAttribute('aria-disabled') : 'n/a') +
    ' promptStillThere=' + (!!probe && promptText().includes(probe)));
  return submitted();
}

// Describe an element for diagnostics
function describeEl(el) {
  if (!el) return 'null';
  const r = el.getBoundingClientRect();
  return (el.tagName || '?') +
    ' aria-label="' + (el.getAttribute && el.getAttribute('aria-label') || '') + '"' +
    ' aria-disabled=' + (el.getAttribute && el.getAttribute('aria-disabled')) +
    ' text="' + NS.normalizeText(el.textContent || '').substring(0, 30) + '"' +
    ' @' + Math.round(r.left) + ',' + Math.round(r.top) +
    ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
}

// Click an element with realistic, coordinate-based pointer + mouse events
function clickElementHard(el) {
  if (!el) return;
  try { el.focus(); } catch { /* ignore */ }
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0 };
  const pBase = { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
  try { el.dispatchEvent(new PointerEvent('pointerover', pBase)); } catch { /* ignore */ }
  try { el.dispatchEvent(new PointerEvent('pointerenter', pBase)); } catch { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('mouseover', base)); } catch { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('mouseenter', base)); } catch { /* ignore */ }
  try { el.dispatchEvent(new PointerEvent('pointerdown', { ...pBase, buttons: 1 })); } catch { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 })); } catch { /* ignore */ }
  try { el.dispatchEvent(new PointerEvent('pointerup', { ...pBase, buttons: 0 })); } catch { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('mouseup', base)); } catch { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('click', base)); } catch { /* ignore */ }
  try { el.click(); } catch { /* ignore */ }
}
  // ── Exports for other content-script module files ──
  NS.findFlowTileContainer = findFlowTileContainer;
  NS.getFlowTileId = getFlowTileId;
  NS.submitFlowPrompt = submitFlowPrompt;
})();