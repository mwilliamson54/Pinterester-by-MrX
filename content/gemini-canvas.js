// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
//
// ── Gemini Canvas "Bulk Media Generator" provider ───────────────────────────
// A Gemini share link (https://gemini.google.com/share/<id>) is only a thin
// wrapper. The real tool runs inside a sandboxed iframe on
// https://<random>.scf.usercontent.goog (a blob: document). The manifest
// injects this content-script set into THAT frame, and this file only does
// anything when content.js detected provider === 'geminicanvas'.
//
// Written against the tool's real source code. Facts this file relies on:
//
//   #aspect-ratio   <select>    1:1 | 16:9 | 9:16 | 4:3 | 3:4
//   #prompt-input   <textarea>  one prompt per line. The Generate button is
//                               DISABLED until the box has text (the tool
//                               listens for an "input" event), so we must type
//                               first and only then wait for the button.
//   #generate-btn   button      hidden (class "hidden") while a run is active
//   #stop-btn       button      visible ONLY while a run is active
//   #image-grid                 EMPTIED by the tool at the start of every run.
//                               Each prompt gets a card #img-card-<n> that goes:
//                                 loader  ->  <img src="data:image/...;base64,..."
//                                             alt="Generated: <prompt>">
//                                 or      ->  red "Generation Failed" card
//   Safety filter: the tool silently REPLACES a blocked prompt with a generic
//   "A visually beautiful, highly stylized, safe and family-friendly digital
//   artwork representing the core concept of: ..." prompt (card shows
//   "Auto-refining..."). That image is NOT what was asked for, so we report it
//   as a moderation failure instead of passing a wrong picture down the pipeline.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;

  const TAG = 'GeminiCanvas';
  const ATTEMPT_TIMEOUT_MS = 150000;   // one prompt: submit -> image visible
  const NO_START_TIMEOUT_MS = 60000;   // clicked Generate but nothing ever reacted
  const RECLICK_AFTER_MS = 15000;      // one gentle re-click if nothing reacted yet
  const POLL_MS = 400;

  const SEL = {
    prompt: '#prompt-input',
    generate: '#generate-btn',
    stop: '#stop-btn',
    aspect: '#aspect-ratio',
    grid: '#image-grid',
    toast: '#error-toast',
    toastMsg: '#error-msg'
  };

  // Text the tool itself puts on a card when it swaps in a sanitized prompt.
  const REFINE_PHRASE = 'a visually beautiful, highly stylized, safe and family-friendly';

  function log(level, msg) {
    try { console.log(`BulkyGen ${TAG}: ${msg}`); } catch (e) { /* ignore */ }
    try { NS.clientLog(level, TAG, msg); } catch (e) { /* ignore */ }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);

  function isShown(el) {
    if (!el) return false;
    if (el.classList && el.classList.contains('hidden')) return false;
    try {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    } catch (e) { /* ignore */ }
    return true;
  }

  function isEnabled(btn) {
    return !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
  }

  // True when this frame really contains the Bulk Media Generator tool.
  // (scf.usercontent.goog serves EVERY Canvas app, so the host alone is not enough.)
  function isUiPresent() {
    return !!(q(SEL.prompt) && q(SEL.generate) && q(SEL.grid));
  }

  function normText(s) {
    return String(s || '').toLowerCase().replace(/[\u2018\u2019\u201C\u201D"'`]/g, '').replace(/\s+/g, ' ').trim();
  }

  function fingerprint(src) {
    if (!src) return '';
    const mid = Math.floor(src.length / 2);
    return `${src.length}|${src.slice(0, 40)}|${src.slice(mid, mid + 80)}|${src.slice(-120)}`;
  }

  // A run is active exactly while the Stop button is showing. (The progress
  // header lingers ~2.5s after the run ends, so it is NOT used.)
  function isGenerationActive() {
    return isShown(q(SEL.stop));
  }

  function toastText() {
    const t = q(SEL.toast);
    if (!t) return '';
    if (t.classList.contains('opacity-0')) return '';
    const m = q(SEL.toastMsg);
    return ((m && m.textContent) || t.textContent || '').trim();
  }

  // ── Grid snapshot / card inspection ──────────────────────────────────────
  function gridCards() {
    const grid = q(SEL.grid);
    return grid ? Array.from(grid.children) : [];
  }

  function takeSnapshot() {
    const els = new WeakSet();
    const fps = new Set();
    for (const card of gridCards()) {
      els.add(card);
      const img = card.querySelector('img');
      const src = img && (img.currentSrc || img.src);
      if (src) fps.add(fingerprint(src));
    }
    return { els, fps };
  }

  function inspectCard(card) {
    const img = card.querySelector('img');
    const src = img ? (img.currentSrc || img.src || '') : '';
    const usable = /^(data:image\/|blob:|https?:)/i.test(src);
    const loaded = !!img && usable && img.complete && (img.naturalWidth || 0) > 0;
    const promptEl = card.querySelector('p');
    const label = normText(((img && img.alt) || '') + ' ' + ((promptEl && promptEl.textContent) || ''));
    const fullText = (card.textContent || '').replace(/\s+/g, ' ').trim();

    // The tool's failure card: red "Generation Failed" + a short reason + "Edit & Retry".
    let errorText = '';
    if (!img && /generation failed/i.test(fullText)) {
      const reason = card.querySelector('p.text-red-300');
      errorText = ((reason && reason.textContent) || fullText).trim().slice(0, 200);
    }

    // The tool swapped in its own "safe" prompt after a safety block.
    const refined = /auto-refining/i.test(fullText) || label.includes(REFINE_PHRASE);

    return { card, img, src, usable, loaded, label, fp: fingerprint(src), errorText, refined };
  }

  // Cards that were not in the grid when we submitted (or whose image changed).
  function freshCards(snapshot) {
    const out = [];
    for (const card of gridCards()) {
      const info = inspectCard(card);
      const isNewEl = !snapshot.els.has(card);
      const isNewImage = info.fp && !snapshot.fps.has(info.fp);
      if (isNewEl || isNewImage) out.push(info);
    }
    return out;
  }

  // The tool sets loading="lazy" on its images. In a background tab a lazy
  // image can stay undecoded forever, so force it to load.
  function nudgeImage(img) {
    try {
      if (img && img.loading === 'lazy') img.loading = 'eager';
      if (img && typeof img.decode === 'function') img.decode().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // ── Page interaction helpers ─────────────────────────────────────────────
  function setNativeValue(el, value) {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function normalizeRatio(r) {
    const m = String(r || '').match(/(\d+)\s*[:x\/]\s*(\d+)/i);
    return m ? `${m[1]}:${m[2]}` : null;
  }

  function applyAspectRatio(aspectRatio) {
    const ratio = normalizeRatio(aspectRatio);
    if (!ratio) return;
    const sel = q(SEL.aspect);
    if (!sel) { log('warn', 'Aspect-ratio dropdown (#aspect-ratio) not found; leaving it unchanged.'); return; }
    const has = Array.from(sel.options).some((o) => o.value === ratio);
    if (!has) {
      log('warn', `Aspect ratio "${aspectRatio}" is not offered by the tool (options: ${Array.from(sel.options).map((o) => o.value).join(', ')}); leaving it unchanged.`);
      return;
    }
    if (sel.value !== ratio) {
      setNativeValue(sel, ratio);
      log('info', `Aspect ratio set to ${ratio}.`);
    }
  }

  async function waitFor(fn, timeoutMs, stepMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs || 250);
    }
    return null;
  }

  // ── The generation routine ───────────────────────────────────────────────
  async function generateGeminiCanvasImage(prompt, itemId, aspectRatio) {
    const startedAt = Date.now();
    const cleanPrompt = String(prompt || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (!cleanPrompt) return { success: false, error: 'Empty prompt', itemId: itemId ?? null };

    try {
      const ready = await waitFor(isUiPresent, 20000, 250);
      if (!ready) throw new Error('Bulk Media Generator page not ready (prompt box / Generate button not found). Open the Gemini share link and let it finish loading.');

      const promptEl = q(SEL.prompt);

      // The tool must be idle before we hand it a new prompt (its text box is
      // locked while a run is active).
      if (isGenerationActive()) {
        log('info', 'Tool is still busy with an earlier generation; waiting for it to finish...');
        const idle = await waitFor(() => !isGenerationActive(), 90000, 400);
        if (!idle) throw new Error('The Gemini tool is still busy (Stop button never went away).');
      }
      if (promptEl.disabled) {
        const unlocked = await waitFor(() => !promptEl.disabled, 15000, 250);
        if (!unlocked) throw new Error('The Gemini tool prompt box stayed locked.');
      }

      const snapshot = takeSnapshot();
      const toastBefore = toastText();

      applyAspectRatio(aspectRatio);

      // Exactly ONE line in the box (one line == one image in this tool).
      // Type FIRST: the Generate button only becomes enabled once the box has text.
      promptEl.focus();
      setNativeValue(promptEl, cleanPrompt);
      await sleep(150);
      if (normText(promptEl.value) !== normText(cleanPrompt)) {
        setNativeValue(promptEl, cleanPrompt);
        await sleep(150);
      }
      if (normText(promptEl.value) !== normText(cleanPrompt)) {
        throw new Error('Could not type the prompt into the Gemini tool.');
      }

      const btnReady = await waitFor(() => isEnabled(q(SEL.generate)) && isShown(q(SEL.generate)), 15000, 200);
      if (!btnReady) throw new Error('Generate button stayed disabled even after typing the prompt.');

      q(SEL.generate).click();
      log('info', `Submitted prompt (item ${itemId ?? '?'}): ${cleanPrompt.slice(0, 80)}${cleanPrompt.length > 80 ? '…' : ''}`);

      const wanted = normText(cleanPrompt).slice(0, 80);
      const submittedAt = Date.now();
      const deadline = submittedAt + ATTEMPT_TIMEOUT_MS;
      let clicks = 1;
      let sawStart = false;
      let lastToast = '';
      let idleNoImageStreak = 0;
      let errorStreak = 0;
      let firstUnmatchedReadyAt = 0;
      let moderated = false;
      let chosen = null;

      while (Date.now() < deadline) {
        const active = isGenerationActive();
        const fresh = freshCards(snapshot);
        const t = toastText();
        if (t && t !== toastBefore) lastToast = t;

        if (active || fresh.length) sawStart = true;

        for (const c of fresh) if (c.img && c.usable && !c.loaded) nudgeImage(c.img);

        // 0) The tool's safety filter fired and it swapped in its own prompt.
        if (fresh.some((c) => c.refined)) moderated = true;
        if (moderated) {
          // Let the tool finish its own second attempt so the next prompt does not collide with it.
          await waitFor(() => !isGenerationActive(), 90000, 400);
          throw new Error('CONTENT_MODERATED: Gemini blocked this prompt (safety filter); the tool replaced it with a generic one, so no usable image was kept.');
        }

        // 1) A finished, matching image?
        const readyCards = fresh.filter((c) => c.loaded);
        if (readyCards.length) {
          const matched = readyCards.filter((c) => !wanted || c.label.includes(wanted));
          if (matched.length) { chosen = matched[matched.length - 1]; break; }
          if (!firstUnmatchedReadyAt) firstUnmatchedReadyAt = Date.now();
          if (readyCards.length === 1 && Date.now() - firstUnmatchedReadyAt > 8000 && !active) {
            log('warn', 'Accepting the only new image although its caption does not match the prompt text (prompt probably contains characters the tool mangles).');
            chosen = readyCards[0];
            break;
          }
        }

        // 2) The tool's red "Generation Failed" card (a moment's confirmation first).
        const errCard = fresh.find((c) => c.errorText);
        if (errCard) {
          errorStreak++;
          if (errorStreak >= 3) throw new Error(`Gemini tool reported a failed image: ${errCard.errorText}`);
        } else {
          errorStreak = 0;
        }

        // 3) Tool went back to idle and produced nothing usable.
        if (sawStart && !active && !readyCards.length && !errCard) {
          idleNoImageStreak++;
          if (idleNoImageStreak >= 15) {
            throw new Error(lastToast
              ? `Gemini tool finished without an image: ${lastToast}`
              : 'Gemini tool finished without producing an image.');
          }
        } else {
          idleNoImageStreak = 0;
        }

        // 4) Click seems to have had no effect.
        const sinceClick = Date.now() - submittedAt;
        const noReaction = !active && !fresh.length && isEnabled(q(SEL.generate)) && isShown(q(SEL.generate));
        if (noReaction && clicks < 2 && sinceClick > RECLICK_AFTER_MS) {
          clicks++;
          log('warn', 'No reaction to the first Generate click; clicking once more.');
          q(SEL.generate).click();
        }
        if (!sawStart && sinceClick > NO_START_TIMEOUT_MS) {
          throw new Error('Clicking Generate had no effect on the Gemini tool.');
        }

        await sleep(POLL_MS);
      }

      if (!chosen) throw new Error(`Timed out after ${Math.round(ATTEMPT_TIMEOUT_MS / 1000)}s waiting for the Gemini tool to produce an image.`);

      // Wait for the tool to finish its own bookkeeping, then confirm the
      // image is complete and no longer changing before reading it.
      await waitFor(() => !isGenerationActive(), 30000, 300);
      let info = inspectCard(chosen.card);
      if (!info.loaded) info = chosen;
      await sleep(500);
      const again = inspectCard(chosen.card);
      if (again.loaded && again.fp === info.fp) info = again;

      const src = info.src;
      let imageData = null;
      if (/^data:image\//i.test(src)) {
        imageData = src;                                  // already inline — no fetch needed
      } else if (src) {
        imageData = await NS.getImageAsBase64(src, info.img);
      }
      if (!imageData || imageData.length < 5000) throw new Error('Captured image was empty or too small.');

      const meta = {
        provider: 'geminicanvas',
        width: (info.img && info.img.naturalWidth) || 0,
        height: (info.img && info.img.naturalHeight) || 0,
        src: `gemini-canvas:${chosen.card.id || 'card'}`,
        type: 'image'
      };
      log('info', `Captured ${meta.width}x${meta.height} image in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
      return { success: true, imageData, itemId: itemId ?? null, meta };
    } catch (error) {
      log('warn', `Generation failed: ${error && error.message ? error.message : error}`);
      return { success: false, error: (error && error.message) || String(error), itemId: itemId ?? null };
    }
  }

  // ── Exports for other content-script module files ──
  NS.isGeminiCanvasUiPresent = isUiPresent;
  NS.generateGeminiCanvasImage = generateGeminiCanvasImage;
})();
