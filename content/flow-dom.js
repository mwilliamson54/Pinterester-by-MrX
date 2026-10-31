// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;



// ─────────────────────────────────────────────────────────────────────────
// Flow tile identity
// ─────────────────────────────────────────────────────────────────────────
// Find the tile container for a given result image. Flow's Angular Material
// rewrite dropped the old data-tile-id attribute entirely; result tiles are
// now <flow-grid-tile-container> elements, and the stable per-image id lives
// directly on the <img> as data-media-id (see getFlowTileId below).
function findFlowTileContainer(img) {
  // A generic parent is not a safe fallback: it can contain controls for a
  // different tile when Flow virtualizes or reorders the project grid.
  return img ? img.closest('flow-grid-tile-container') : null;
}

function getFlowTileId(img) {
  return img?.getAttribute?.('data-media-id') || null;
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
// tabs. Flow's rewrite to Angular Material dropped the old aria-haspopup="menu"
// + <i> ligature markup in favor of aria-label="Settings trigger" /
// class="settings-trigger-button" with a <mat-icon> ligature — match both so
// this survives either markup.
function findFlowRatioTriggerButton() {
  const buttons = Array.from(document.querySelectorAll(
    'button[aria-label="Settings trigger"], button.settings-trigger-button, button[aria-haspopup="menu"]'
  ));
  for (const btn of buttons) {
    const icon = Array.from(btn.querySelectorAll('mat-icon, i'))
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
// (e.g. "16:9"), matched by its own icon ligature. The Angular Material
// rewrite renders this as a <flow-toggles aria-label="Aspect ratio"> holding
// a mat-button-toggle-group of role="radio" buttons inside a CDK overlay
// pane, rather than the old Radix role="tab" menu — check both shapes.
function findFlowRatioTabButton(ratio) {
  const iconName = FLOW_ASPECT_RATIO_ICONS[ratio];
  if (!iconName) return null;
  const roots = [
    document.querySelector('flow-toggles[aria-label="Aspect ratio"]'),
    document.querySelector('[data-radix-menu-content][data-state="open"]'),
    document.querySelector('[role="menu"][data-state="open"]'),
    document // fall back to whole doc in case the open-state attr differs
  ].filter(Boolean);
  for (const root of roots) {
    const options = Array.from(root.querySelectorAll('button[role="radio"], button[role="tab"]'));
    for (const opt of options) {
      const icon = opt.querySelector('mat-icon, i');
      if (icon && (icon.textContent || '').trim() === iconName) return opt;
    }
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
    trigger.button.getAttribute('data-state') === 'open' ||
    !!document.querySelector('flow-prompt-box-settings');
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

// NOTE: the submit / capture / recover state machine that used to live here
// (submitFlowPromptInternal) moved to content/flow-job.js. It needs the helpers
// below (composer, inject, click, ratio) which are exported at the bottom of
// this file.

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
  // Dispatch exactly ONE click event — el.click() right after this used to
  // fire a second, independent click on the same button (see the matching
  // note in background/tab-lifecycle.js's mainWorldForceClick), which is
  // what was causing Flow to receive two generate requests per submission.
  try { el.dispatchEvent(new MouseEvent('click', base)); } catch { /* ignore */ }
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


// Wait for the generate button to be enabled, then click it; verify submission.
//
// Returns { submitted, clicked, by, blocked?, reason? }
//   clicked    true once ANY real click/keypress was dispatched (the job may now
//              have been charged, even if we could not see the receipt)
//   submitted  true only when we saw positive evidence Flow accepted it
//   by         which evidence matched (composer_cleared / button_disabled /
//              tile_added / image_added / error_tile_added)
//
// `gate` (optional) is awaited right before the FIRST click. It is the
// write-ahead credit guard: it asks the background job ledger for permission
// and may veto the click.
async function clickFlowGenerate(editor, prompt, gate) {
  let btn = findFlowSubmitButton(editor);
  for (let i = 0; i < 25 && !isFlowButtonReady(btn); i++) {
    await NS.waitUnthrottled(200);
    btn = findFlowSubmitButton(editor);
  }
  if (!btn) {
    console.log('BulkyGen Flow: generate button NOT found');
    return { submitted: false, clicked: false, by: '', reason: 'generate button not found' };
  }
  console.log('BulkyGen Flow: generate button =>', describeEl(btn));

  const probe = prompt.trim().substring(0, Math.min(12, prompt.trim().length));
  const promptText = () => (editor.innerText || editor.textContent || '').trim();
  const hadPrompt = !!probe && promptText().includes(probe);
  const countImgs = () => NS.collectResultElements().filter(el => el.tagName === 'IMG').length;
  const countTiles = () => document.querySelectorAll('flow-grid-tile-container').length;
  const countErrs = () => document.querySelectorAll('flow-error-tile').length;
  const baseImgCount = countImgs();
  const baseTileCount = countTiles();
  const baseErrCount = countErrs();

  // Evidence that Flow accepted the submission. Several independent signals,
  // checked in order of reliability. Returns the name of the first that matches.
  const submittedBy = () => {
    const stillThere = !!probe && promptText().includes(probe);
    if (hadPrompt && !stillThere) return 'composer_cleared';
    const cur = findFlowSubmitButton(editor);
    if (cur && cur.getAttribute('aria-disabled') === 'true') return 'button_disabled';
    if (countTiles() > baseTileCount) return 'tile_added';
    if (countImgs() > baseImgCount) return 'image_added';
    if (countErrs() > baseErrCount) return 'error_tile_added';
    return '';
  };

  let clicked = false;
  const result = (by) => ({ submitted: !!by, clicked, by: by || '' });

  // Credit guard: last possible moment before anything is clicked.
  if (typeof gate === 'function') {
    const verdict = await gate();
    if (!verdict || verdict.allowed === false) {
      return { submitted: false, clicked: false, by: '', blocked: true, reason: (verdict && verdict.reason) || 'submit not authorized' };
    }
  }

  // Give Slate/React a moment to fully wire the enabled button
  await NS.waitUnthrottled(80);

  for (let attempt = 0; attempt < 5; attempt++) {
    const target = findFlowSubmitButton(editor) || btn;
    if (target) {
      NS.markFlowProgrammaticScroll();
      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      await NS.waitUnthrottled(40);
      // Strongest method: a single real click on the button from the main world.
      clicked = true;
      await forceClickViaBackground(target);
      // Patiently poll (~4s) for the receipt before escalating. Every extra
      // click on a button that already registered the first one can create a
      // second, separately charged generation, so escalating too early is the
      // expensive mistake. Flow's Angular change detection + composer clear can
      // easily take longer than one fixed short wait.
      for (let i = 0; i < 20; i++) {
        await NS.waitUnthrottled(200);
        const by = submittedBy();
        if (by) return result(by);
      }

      // Fallback: escalate through ONE click method at a time, checking for a
      // receipt after each, so we stop the instant it registers.
      const r = target.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      const inner = target.querySelector('i, span, svg');
      const fallbackSteps = [
        () => realClick(target),
        () => (top && top !== target) ? realClick(top) : null,
        () => inner ? realClick(inner) : null,
        () => { try { target.focus(); } catch { /* ignore */ } pressKey(target, 'Enter'); },
        () => { try { target.focus(); } catch { /* ignore */ } pressKey(target, ' '); }
      ];
      for (const step of fallbackSteps) {
        await step();
        await NS.waitUnthrottled(400);
        const by = submittedBy();
        if (by) return result(by);
      }
    }
    await NS.waitUnthrottled(250);
    const curBtn = findFlowSubmitButton(editor);
    console.log('BulkyGen Flow: click attempt ' + (attempt + 1) +
      ' -> connected=' + (target ? document.contains(target) : 'n/a') +
      ' aria=' + (curBtn ? curBtn.getAttribute('aria-disabled') : 'n/a') +
      ' promptStillThere=' + (!!probe && promptText().includes(probe)));
    const by = submittedBy();
    if (by) return result(by);
    await NS.waitUnthrottled(150);
  }

  // Last resort: keyboard submit inside the editor (plain, Ctrl+Enter, Cmd+Enter)
  editor.focus();
  clicked = true;
  pressKey(editor, 'Enter');
  await NS.waitUnthrottled(400);
  let by = submittedBy();
  if (by) return result(by);
  pressKey(editor, 'Enter', { ctrlKey: true });
  await NS.waitUnthrottled(400);
  by = submittedBy();
  if (by) return result(by);
  pressKey(editor, 'Enter', { metaKey: true });
  await NS.waitUnthrottled(500);
  return result(submittedBy());
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
  // Single click dispatch only — see the note in realClick() above.
  try { el.dispatchEvent(new MouseEvent('click', base)); } catch { /* ignore */ }
}
  // ── Exports for other content-script module files ──
  NS.findFlowTileContainer = findFlowTileContainer;
  NS.getFlowTileId = getFlowTileId;
  NS.findFlowComposer = findFlowComposer;
  NS.injectFlowPrompt = injectFlowPrompt;
  NS.clickFlowGenerate = clickFlowGenerate;
  NS.ensureFlowAspectRatio = ensureFlowAspectRatio;
  NS.findFlowSubmitButton = findFlowSubmitButton;
  NS.isFlowButtonReady = isFlowButtonReady;
})();