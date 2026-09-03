// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;



// Internal generation logic (renamed from NS.generateImage)
async function generateImageInternal(prompt, itemId) {
  console.log('🚀 Starting generation for prompt:', prompt);

  NS.logButtonInventoryOnce();

  NS.maybeWarnAboutFlowModel();

  // First, wait for UI to be ready
  console.log(`Waiting for UI to be ready (${NS.PROVIDER})...`);
  const uiReady = await NS.waitForProviderUI();
  if (!uiReady) {
    throw new Error('UI not ready. Please make sure the prompt input and Start/Generate button are visible on the page.');
  }

  try {
    // Step 1: Find and fill prompt input
    console.log('📝 Looking for prompt input...');
    let promptInput = await NS.waitForElement(NS.SELECTORS.promptInput, 10000).catch(() => {
      // Fallback: try to find any textarea or contenteditable
      console.log('Trying fallback selectors...');
      return document.querySelector('textarea') ||
        document.querySelector('[contenteditable="true"]') ||
        document.querySelector('div[role="textbox"]');
    });

    if (!promptInput) {
      throw new Error('Could not find prompt input field - please make sure you are on the Generate page');
    }

    if (NS.PROVIDER === 'gentube') {
      const gentubePrompt = NS.findGentubePromptInput();
      if (gentubePrompt) {
        promptInput = gentubePrompt;
        console.log('✅ Gentube: Using best-matched composer input');
      } else {
        console.log('⚠️ Gentube: Best-match composer not found, using default selector result');
      }
    }

    console.log('✅ Found prompt input:', promptInput.tagName, promptInput.className);

    // IMPORTANT: First blur then re-focus to reset any stale state from previous generation
    // This fixes the issue where 2nd prompt doesn't paste after 1st generation completes
    promptInput.blur();
    await NS.waitUnthrottled(200);

    // Clear and focus
    promptInput.focus();
    promptInput.click();

    await NS.waitUnthrottled(300);

    // For Gentube: specific typing emulation via execCommand to appease its React textareas
      if (NS.PROVIDER === 'gentube') {
        console.log('🔧 Gentube: Direct text assignment methodology');
        promptInput.focus();
        promptInput.click();

        try {
          const proto = Object.getPrototypeOf(promptInput) || window.HTMLTextAreaElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(promptInput, prompt);
          } else {
            promptInput.value = prompt;
          }
        } catch (e) {
          promptInput.value = prompt;
        }

        if (promptInput._valueTracker) {
          promptInput._valueTracker.setValue('');
        }
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        promptInput.dispatchEvent(new Event('change', { bubbles: true }));

        // Final space insertion using React's event pipeline equivalent
        document.execCommand('insertText', false, ' ');

        await NS.waitUnthrottled(400);
        console.log('✅ Gentube prompt finalization complete');

      } else if (NS.PROVIDER === 'metaai') {
      console.log('🔧 Meta AI: Using special contenteditable handling...');

      // SMART PROMPT: If user wants video (keywords found), ensure it starts with "animate"
      let finalPrompt = prompt;
      const lowPrompt = prompt.toLowerCase();
      if (lowPrompt.includes('video') || lowPrompt.includes('animate') || lowPrompt.includes('motion')) {
        if (!lowPrompt.startsWith('animate') && !lowPrompt.startsWith('/animate')) {
          finalPrompt = 'animate ' + prompt;
          console.log('🎬 Meta AI: Auto-prepend "animate" for video generation');
        }
      }

      // Clear the contenteditable
      promptInput.innerHTML = '';
      promptInput.textContent = '';
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));

      await NS.waitUnthrottled(200);

      // Focus and use execCommand for React compatibility
      promptInput.focus();

      // Typing helper
      const typeWithDelay = async (text, delay) => {
        for (const char of text) {
          document.execCommand('insertText', false, char);
          await NS.waitUnthrottled(delay);
        }
      };

      // Try 1: Standard typing (20ms delay) - increased from 5ms to avoid dropped chars
      await typeWithDelay(finalPrompt, 20);

      // Verify input fidelity
      await NS.waitUnthrottled(300);
      let currentVal = promptInput.innerText || promptInput.textContent || '';

      // Check if text matches (ignoring whitespace differences)
      if (NS.normalizeText(currentVal) !== NS.normalizeText(finalPrompt)) {
        console.warn('⚠️ Meta AI prompt mismatch detected!', { expected: finalPrompt, actual: currentVal });
        console.log('🔄 Retrying slowly (50ms)...');

        // Clear and retry
        promptInput.innerHTML = '';
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        await NS.waitUnthrottled(300);
        promptInput.focus();

        await typeWithDelay(finalPrompt, 60);

        // Verify again
        await NS.waitUnthrottled(500);
        currentVal = promptInput.innerText || promptInput.textContent || '';
        if (NS.normalizeText(currentVal) !== NS.normalizeText(finalPrompt)) {
          console.error('❌ Still mismatch after retry. Using fallback block insert.');
          // Final fallback: insert whole block (faster but might bypass some React logic)
          promptInput.innerHTML = '';
          await NS.waitUnthrottled(200);
          promptInput.focus();
          document.execCommand('insertText', false, finalPrompt);
        } else {
          console.log('✅ Retry successful: Prompt matches.');
        }
      } else {
        console.log('✅ Prompt verified: Text matches.');
      }

      // Dispatch events to trigger React
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.dispatchEvent(new Event('change', { bubbles: true }));
      promptInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: finalPrompt }));

      console.log('✅ Meta AI prompt finalization complete');

      // Verify the value was set
      await NS.waitUnthrottled(500);
      const metaValue = promptInput.textContent || promptInput.innerText || '';
      console.log('📊 Meta AI prompt value:', metaValue ? metaValue.substring(0, 50) + '...' : '❌ EMPTY!');

      if (!metaValue || metaValue.length === 0) {
        throw new Error('Failed to set Meta AI prompt - please try manually typing first');
      }

      // Skip the rest of the input handling for Meta AI

    } else if (promptInput.tagName === 'TEXTAREA' || promptInput.tagName === 'INPUT') {
      // AGGRESSIVE CLEAR: Reset everything before entering new prompt
      // This fixes the issue where 2nd, 4th, 6th... prompts don't paste correctly

      console.log('🔧 Using TEXTAREA/INPUT handling with aggressive clear...');

      // Step 1: Blur to release any pending React state
      promptInput.blur();
      await NS.waitUnthrottled(10);

      // Step 2: Focus fresh
      promptInput.focus();
      promptInput.click();
      await NS.waitUnthrottled(10);

      // Step 3: Select all existing content
      promptInput.select?.();

      // Step 4: Use execCommand to delete all selected content
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      // Step 5: Clear the value directly
      promptInput.value = '';

      // Step 6: Reset React's value tracker BEFORE setting new value
      // This is crucial - React caches the previous value and won't update if it thinks it's the same
      const tracker = promptInput._valueTracker;
      if (tracker) {
        tracker.setValue('');
      }

      // Dispatch input event for the clear
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.dispatchEvent(new Event('change', { bubbles: true }));

      await NS.waitUnthrottled(10);

      // Verify the textarea is actually empty
      if (promptInput.value.length > 0) {
        console.log('⚠️ Textarea not fully cleared, forcing clear...');
        promptInput.value = '';
        if (tracker) tracker.setValue('');
      }

      // Now set the new prompt value using React-compatible method
      const proto = promptInput.tagName === 'INPUT'
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype;

      // Get the native setter
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!nativeInputValueSetter) {
        throw new Error('Failed to access native value setter for prompt input');
      }

      // Set value using native setter (bypasses React's controlled component)
      nativeInputValueSetter.call(promptInput, prompt);

      // Reset tracker AGAIN after setting value (some React versions check this on next render)
      if (tracker) {
        tracker.setValue('');
      }

      // Create and dispatch input event with proper React event properties
      const inputEvent = new Event('input', { bubbles: true });
      inputEvent.simulated = true;
      promptInput.dispatchEvent(inputEvent);

      // Also dispatch change event
      promptInput.dispatchEvent(new Event('change', { bubbles: true }));

      // Dispatch InputEvent for good measure
      promptInput.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: prompt
      }));

    } else if (promptInput.isContentEditable || promptInput.getAttribute('contenteditable') === 'true') {
      // For contenteditable divs (Grok uses ProseMirror/Tiptap)
      console.log('🔧 Using contenteditable handling (ProseMirror/Tiptap)...');

      // Clear the contenteditable
      promptInput.innerHTML = '';
      promptInput.textContent = '';
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));

      await NS.waitUnthrottled(10);

      // Focus and use execCommand for React/ProseMirror compatibility
      promptInput.focus();

      // Use document.execCommand for ProseMirror compatibility
      // First select all existing content
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      await NS.waitUnthrottled(100);

      // Insert the prompt text - for shorter prompts, insert all at once
      // For longer prompts, we need character-by-character to avoid issues
      if (prompt.length <= 200) {
        document.execCommand('insertText', false, prompt);
      } else {
        // Insert in chunks for longer prompts
        const chunkSize = 50;
        for (let i = 0; i < prompt.length; i += chunkSize) {
          const chunk = prompt.substring(i, i + chunkSize);
          document.execCommand('insertText', false, chunk);
          await NS.waitUnthrottled(10);
        }
      }

      // Dispatch events to trigger framework updates
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.dispatchEvent(new Event('change', { bubbles: true }));
      promptInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt }));

      console.log('✅ Contenteditable prompt entered');
    }

    // Verify prompt was set (skip for Meta AI as we already verified above)
    if (NS.PROVIDER !== 'metaai') {
      console.log('✅ Prompt entered:', prompt.substring(0, 50) + '...');

      // Verify the value was set
      await NS.waitUnthrottled(200);
      const currentValue = promptInput.value || promptInput.textContent || '';
      console.log('📊 Prompt input value:', currentValue ? currentValue.substring(0, 50) + '...' : '❌ EMPTY!');

      // If empty, try one more time with a different method
      if (!currentValue || currentValue.length === 0) {
        console.log('⚠️ Prompt is empty, trying alternative method (execCommand)...');

        // Blur and re-focus to fully reset state
        promptInput.blur();
        await NS.waitUnthrottled(100);
        promptInput.focus();
        promptInput.click();
        await NS.waitUnthrottled(100);

        // Select all and delete
        promptInput.select?.();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);

        await NS.waitUnthrottled(10);

        // For textarea/input: Try character-by-character typing simulation
        if (promptInput.tagName === 'TEXTAREA' || promptInput.tagName === 'INPUT') {
          // First try setting value directly again with fresh tracker reset
          const tracker = promptInput._valueTracker;
          if (tracker) {
            tracker.setValue('');
          }
          promptInput.value = '';

          // Now type character by character for React compatibility
          for (const char of prompt) {
            const currentPos = promptInput.value.length;
            promptInput.setSelectionRange?.(currentPos, currentPos);
            document.execCommand('insertText', false, char);
          }
        } else {
          // For contenteditable: use insertText
          document.execCommand('insertText', false, prompt);
        }

        // Dispatch events
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        promptInput.dispatchEvent(new Event('change', { bubbles: true }));

        await NS.waitUnthrottled(200);

        const retryValue = promptInput.value || promptInput.textContent || '';
        console.log('📊 After retry:', retryValue ? retryValue.substring(0, 50) + '...' : '❌ STILL EMPTY!');

        if (!retryValue || retryValue.length === 0) {
          throw new Error('Failed to set prompt value - textarea may be read-only or React is blocking changes');
        }
      }
    }

    // Step 2: Wait for React to update UI
    console.log('⏳ Waiting for React to process prompt value...');
    await NS.waitUnthrottled(10);

    // Step 3: Wait for UI to be ready to submit
    console.log('⏳ Waiting for UI to be ready to submit...');
    await NS.waitUnthrottled(500); // Increased wait to ensure UI is fully ready

    // Snapshot existing results BEFORE submitting
    const allElements = NS.collectResultElements();
    const prevKeys = new Set(allElements.map(NS.elementKey).filter(Boolean));
    console.log(`📸 Snapshot taken: ${prevKeys.size} existing result elements`);


    const isConv = NS.isFlowConversationPage();
    const providerConfig = NS.PROVIDERS[NS.PROVIDER] || NS.PROVIDERS.flow;
    const submitViaEnter = providerConfig.submitViaEnter || isConv;
    const clickSubmitButton = providerConfig.clickSubmitButton || false;

    // Grok: Find and click the submit button (arrow icon near input)
    // NOTE: Check Grok FIRST before the generic clickSubmitButton path
    if (NS.PROVIDER === 'grok') {
      console.log('🔍 Grok: Looking for submit button...');

      let submitBtn = null;

      // Helper: Check if element has ANY upward arrow SVG (submit icon)
      function hasUpwardArrowSvg(el) {
        const svg = el.querySelector('svg');
        if (!svg) return false;
        const path = svg.querySelector('path');
        if (!path) return false;
        const d = path.getAttribute('d') || '';
        // Various upward arrow patterns:
        // "M6 11L12 5M12 5L18 11M12 5V19" or "M12 5V19" or contains arrow-like movement
        // Also check for common arrow icon patterns
        return (d.includes('12 5') && d.includes('V19')) ||
          (d.includes('M12') && d.includes('V') && d.includes('L')) ||
          (d.includes('arrow') || svg.innerHTML.includes('arrow'));
      }

      // Helper: Check if element looks like a submit button
      function isLikelySubmitButton(el) {
        const classes = el.className || '';
        const isRounded = classes.includes('rounded-full') || classes.includes('rounded-lg') || classes.includes('rounded');
        const hasArrow = hasUpwardArrowSvg(el);
        const text = (el.textContent || '').trim().toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

        // Skip buttons that are definitely NOT for submitting prompts
        if (text === 'redo' || ariaLabel.includes('redo')) {
          return false;
        }

        // Skip if it has wrong labels
        if (ariaLabel.includes('attach') || ariaLabel.includes('video options') ||
          ariaLabel.includes('upload') || ariaLabel.includes('emoji') ||
          text.includes('attach') || text.includes('options')) {
          return false;
        }

        // Accept "Make video" button - THIS IS the submit button for video generation!
        // On Grok /imagine page, "Make video" with arrow is the submit button
        if (text.includes('make video') || ariaLabel.includes('make video')) {
          console.log('🎬 Grok: Found "Make video" button - this is the submit button');
          return true;
        }

        // Accept aria-label "submit" or "send"
        if (ariaLabel === 'submit' || ariaLabel.includes('send')) {
          return true;
        }

        // Accept if it has the arrow SVG and is rounded (the actual submit button)
        if (hasArrow && isRounded) {
          return true;
        }

        // Accept any button with SVG that's near the input and small (icon button)
        const hasSvg = !!el.querySelector('svg');
        const rect = el.getBoundingClientRect();
        if (hasSvg && rect.width < 80 && rect.height < 80 && isRounded) {
          return true;
        }

        return false;
      }

      // First: Look for "Make video" button explicitly (this is the main submit button)
      const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"]'));
      for (const btn of allButtons) {
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;

        const text = (btn.textContent || '').trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

        if (text.includes('make video') || ariaLabel.includes('make video')) {
          submitBtn = btn;
          console.log('✅ Grok: Found "Make video" button as submit');
          break;
        }
      }

      // Second: Look for arrow submit button near input
      if (!submitBtn && promptInput) {
        let parent = promptInput.parentElement;
        for (let i = 0; i < 6 && parent && !submitBtn; i++) {
          // Look for both buttons AND divs (Grok uses div for the arrow icon)
          const candidates = parent.querySelectorAll('button, div[role="button"], div.rounded-full, [role="button"]');
          for (const el of candidates) {
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;

            if (isLikelySubmitButton(el)) {
              submitBtn = el;
              const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
              const text = (el.textContent || '').trim();
              console.log('✅ Grok: Found submit button at level', i, ':', ariaLabel || text || '[arrow icon]');
              break;
            }
          }
          parent = parent.parentElement;
        }
      }

      // Third: Look for any element with the arrow SVG anywhere on page
      if (!submitBtn) {
        console.log('🔍 Grok: Trying broader search for submit button...');
        const allCandidates = document.querySelectorAll('button, div[role="button"], div.rounded-full, [role="button"]');
        for (const el of allCandidates) {
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
          if (isLikelySubmitButton(el)) {
            submitBtn = el;
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            const text = (el.textContent || '').trim();
            console.log('✅ Grok: Found submit button via broad search:', ariaLabel || text || '[arrow icon]');
            break;
          }
        }
      }

      // Click the submit button or fall back to Enter key
      if (submitBtn) {
        // Wait for button to be potentially enabled/ready
        await NS.waitUnthrottled(50);

        // Click immediately
        submitBtn.focus();
        submitBtn.click();
        console.log('✅ Grok: Submit button clicked');

        // Double check: if it didn't register (still no "Generating..." after 500ms), try again
        // This handles cases where the first click happened before listeners were active
      } else {
        // Last resort: try Enter key
        console.log('⚠️ Grok: No submit button found, using Enter key...');
        promptInput.focus();
        NS.dispatchEnterToSubmit(promptInput);
        console.log('✅ Grok: Enter key dispatched');
      }

    } else if (NS.PROVIDER === 'metaai') {
      // Meta AI: Find and click the submit button (blue arrow)
      console.log('🔍 Meta AI: Looking for submit button...');

      let submitBtn = null;

      // Try to find the submit button near the input
      const allButtons = Array.from(document.querySelectorAll('div[role="button"], button'));
      console.log(`🔍 Found ${allButtons.length} potential buttons`);

      for (const btn of allButtons) {
        const hasSvg = btn.querySelector('svg');
        const isNearInput = promptInput.parentElement?.contains(btn) ||
          promptInput.closest('form')?.contains(btn) ||
          btn.closest('[class*="composer"]') ||
          btn.closest('[class*="input"]');
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const isSendButton = ariaLabel.includes('send') || ariaLabel.includes('submit');

        if ((hasSvg || isSendButton) && !btn.disabled) {
          console.log('🔍 Checking button:', {
            hasSvg: !!hasSvg,
            ariaLabel,
            className: btn.className.substring(0, 50)
          });

          if (isSendButton || (hasSvg && isNearInput)) {
            submitBtn = btn;
            break;
          }
        }
      }

      // Fallback: find any clickable button near the input container
      if (!submitBtn) {
        console.log('🔍 Meta AI: Trying fallback button search...');
        let parent = promptInput.parentElement;
        for (let i = 0; i < 6 && parent; i++) {
          const btns = parent.querySelectorAll('div[role="button"], button');
          for (const btn of btns) {
            if (!btn.disabled && btn.querySelector('svg')) {
              submitBtn = btn;
              console.log('✅ Meta AI: Found button via fallback at level', i);
              break;
            }
          }
          if (submitBtn) break;
          parent = parent.parentElement;
        }
      }

      if (!submitBtn) {
        throw new Error('Could not find Meta AI submit button - please make sure the input is visible');
      }

      console.log('✅ Meta AI: Found submit button');
      submitBtn.focus();
      submitBtn.click();
      console.log('✅ Meta AI: Submit button clicked');

    } else if (NS.PROVIDER === 'gentube') {
      console.log('🔍 Gentube: Looking for submit button near prompt...');

      let submitBtn = null;
      const promptRect = promptInput.getBoundingClientRect();

      function scoreGentubeSubmitButton(btn) {
        if (!btn) return -1;
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return -1;

        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return -1;

        const text = (btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const hasSvg = !!btn.querySelector('svg');

        let score = 0;

        if (text.includes('create') || text.includes('generate') || text.includes('send')) score += 200;
        if (aria.includes('create') || aria.includes('generate') || aria.includes('send')) score += 220;
        if (hasSvg) score += 40;

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const promptRight = promptRect.right;
        const promptCenterY = promptRect.top + promptRect.height / 2;

        const dx = centerX - promptRight;
        const dy = Math.abs(centerY - promptCenterY);

        // Prefer button just to the right of the textarea and vertically aligned
        if (dx >= -30 && dx <= 180) score += 220;
        if (dy <= 80) score += 120;

        // Penalize left-side utility buttons (wand/settings/time chips)
        if (centerX < promptRect.left + 20) score -= 250;
        if (dx < -60) score -= 180;

        // Prefer compact icon/send button sizes
        if (rect.width <= 72 && rect.height <= 72) score += 70;

        return score;
      }

      if (promptInput) {
        const candidateSet = new Set();

        // collect local candidates first (same container hierarchy)
        let parent = promptInput.parentElement;
        for (let i = 0; i < 7 && parent; i++) {
          const candidates = parent.querySelectorAll('button, [role="button"]');
          for (const btn of candidates) {
            candidateSet.add(btn);
          }
          parent = parent.parentElement;
        }

        // add global candidates as fallback
        document.querySelectorAll('button, [role="button"]').forEach(btn => candidateSet.add(btn));

        let best = null;
        let bestScore = -1;
        for (const btn of candidateSet) {
          const score = scoreGentubeSubmitButton(btn);
          if (score > bestScore) {
            bestScore = score;
            best = btn;
          }
        }

        if (best && bestScore >= 120) {
          submitBtn = best;
          console.log('✅ Gentube: Best submit candidate score =', bestScore);
        }
      }

      if (!submitBtn) {
        submitBtn = NS.findActionButtonNearPrompt(promptInput, NS.ACTION_KEYWORDS) || NS.findElement(NS.SELECTORS.actionButton);
      }

      if (!submitBtn) {
        console.log('⚠️ Gentube: submit button not found, trying Enter key fallback...');
        promptInput.focus();
        NS.dispatchEnterToSubmit(promptInput);
        await NS.waitUnthrottled(300);
      } else {
        submitBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await NS.waitUnthrottled(100);
        submitBtn.focus();
        submitBtn.click();
        submitBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        submitBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        console.log('✅ Gentube: Submit button clicked');
      }

    } else if (NS.PROVIDER === 'flow' && clickSubmitButton) {
      // Flow: Find and click the submit button instead of Enter
      console.log('🔍 Flow: Looking for submit button...');

      let submitBtn = null;

      // Try to find the submit button near the input
      if (promptInput) {
        let parent = promptInput.parentElement;
        for (let i = 0; i < 6 && parent && !submitBtn; i++) {
          const btns = parent.querySelectorAll('button, div[role="button"]');
          for (const btn of btns) {
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
            const text = (btn.textContent || '').trim().toLowerCase();
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            const hasSvg = btn.querySelector('svg');

            // Look for start/run/generate button or icon button near input
            if (text.includes('start') || text.includes('run') || text.includes('generate') ||
              ariaLabel.includes('start') || ariaLabel.includes('run') || ariaLabel.includes('generate')) {
              submitBtn = btn;
              console.log('✅ Flow: Found submit button at level', i);
              break;
            }

            // Also accept type="submit" or arrow icons near input
            const btnType = (btn.type || btn.getAttribute('type') || '').toLowerCase();
            if ((btnType === 'submit' || (hasSvg && btn.offsetWidth < 60)) && !text.includes('add image')) {
              submitBtn = btn;
              console.log('✅ Flow: Found icon/submit button at level', i);
              break;
            }
          }
          parent = parent.parentElement;
        }
      }

      // Fallback: use generic button finder
      if (!submitBtn) {
        console.log('🔍 Flow: Trying generic button search...');
        submitBtn = NS.findActionButtonNearPrompt(promptInput, NS.ACTION_KEYWORDS);
      }

      if (!submitBtn) {
        console.log('⚠️ Flow: No submit button found, falling back to Enter key...');
        promptInput.focus();
        NS.dispatchEnterToSubmit(promptInput);
        console.log('✅ Flow: Enter key dispatched (fallback)');
      } else {
        submitBtn.focus();
        submitBtn.click();
        console.log('✅ Flow: Submit button clicked');
      }

    } else if (submitViaEnter) {
      console.log(`🖱️ Submitting via Enter (${NS.PROVIDER})...`);
      promptInput.focus();
      NS.dispatchEnterToSubmit(promptInput);
      console.log('✅ Enter submit dispatched');
    } else {
      console.log('⏳ Waiting for UI to enable Generate button...');
      await NS.waitUnthrottled(1500);

      console.log('🔍 Looking for action button...');
      let generateBtn = await NS.waitForElement(NS.SELECTORS.actionButton, 10000).catch(() => {
        // Fallback: find button with action text by searching everywhere
        console.log('Trying fallback for action button...');

        // For Digen: look for icon buttons near textarea first
        if (NS.PROVIDER === 'digen' && promptInput) {
          console.log('🔍 Digen fallback: searching for buttons near textarea...');
          const digenBtn = NS.findActionButtonNearPrompt(promptInput, NS.ACTION_KEYWORDS);
          if (digenBtn) {
            console.log('✅ Digen fallback: found button via proximity search');
            return digenBtn;
          }
        }

        // Check main DOM - exclude dropdown menus
        let buttons = Array.from(document.querySelectorAll('button'));
        console.log(`🔍 Fallback: checking ${buttons.length} buttons in main DOM`);

        for (const btn of buttons) {
          const text = btn.textContent.toLowerCase().trim();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const btnType = (btn.type || btn.getAttribute('type') || '').toLowerCase();

          if (btn.disabled) continue;
          const isSubmit = btnType === 'submit';
          const hit = NS.ACTION_KEYWORDS.some(kw => kw && (text === kw || ariaLabel.includes(kw)));
          if (hit && (isSubmit || text === 'start' || text === 'generate' || text === 'create' || text === 'run')) {
            console.log('Found in main DOM (non-dropdown):', btn.textContent, 'aria-label:', ariaLabel);
            return btn;
          }
        }

        // Check ALL shadow DOMs recursively
        function findInShadow(root) {
          const elements = root.querySelectorAll('*');
          for (const el of elements) {
            if (el.shadowRoot) {
              const shadowButtons = el.shadowRoot.querySelectorAll('button,[role="button"]');
              for (const btn of shadowButtons) {
                const text = NS.normalizeText(btn.textContent);
                const ariaLabel = NS.normalizeText(btn.getAttribute('aria-label'));
                const title = NS.normalizeText(btn.getAttribute('title'));
                const btnType = NS.normalizeText(btn.type || btn.getAttribute('type'));
                const disabled = !!btn.disabled || btn.getAttribute('aria-disabled') === 'true';
                const isUpload = ariaLabel.includes('upload');
                const hit = NS.ACTION_KEYWORDS.some(kw => text === kw || ariaLabel.includes(kw) || title.includes(kw));

                if (!disabled && !isUpload && hit) {
                  return btn;
                }
              }
              // Recurse into nested shadow DOMs
              const found = findInShadow(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }

        const shadowBtn = findInShadow(document);
        if (shadowBtn) return shadowBtn;

        // Final fallback: find a submit/arrow button near the prompt input
        return NS.findActionButtonNearPrompt(promptInput, NS.ACTION_KEYWORDS);
      });

      if (!generateBtn) {
        throw new Error('Could not find generate button - is the prompt field filled and visible?');
      }

      console.log('✅ Found generate button:', generateBtn.textContent.trim() || '[no text]',
        'type:', generateBtn.type,
        'aria-label:', generateBtn.getAttribute('aria-label'));

      // Check button state before clicking
      const isDisabled = generateBtn.disabled || generateBtn.hasAttribute('disabled');
      const ariaDisabled = generateBtn.getAttribute('aria-disabled') === 'true';

      console.log('📊 Button state: disabled=', isDisabled, 'aria-disabled=', ariaDisabled);

      if (isDisabled || ariaDisabled) {
        console.log('⚠️ Generate button is disabled! Prompt might not be valid. Waiting 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check again
        if (generateBtn.disabled || generateBtn.getAttribute('aria-disabled') === 'true') {
          throw new Error('Generate button is disabled - prompt may not be valid or too short');
        }
      }

      // Scroll button into view
      generateBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await NS.waitUnthrottled(10);

      // Click ONCE (double-clicking often triggers duplicate generations)
      console.log('🖱️ Clicking action button (single click)...');
      generateBtn.focus();
      generateBtn.click();
      console.log('✅ Generate click dispatched');
    }

    // Wait a moment for click to register and UI to update to "Generating..." state
    await NS.waitUnthrottled(1000);

    // Wait for generation to complete

    // For Grok: Wait for generation to START (button should show "Generating...")
    // This ensures the prompt was actually submitted before we start looking for results
    // For Grok AND Whisk: Wait for generation to START (button should show "Generating...")
    // This ensures the prompt was actually submitted before we start looking for results
    if (NS.PROVIDER === 'grok' || NS.PROVIDER === 'whisk') {
      console.log(`⏳ ${NS.PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Waiting for generation to start...`);
      let generationStarted = false;
      const startWaitTime = Date.now();
      // Reduced from 2s to 1s - consistent with background execution needs
      const maxStartWait = 1000;

      while (Date.now() - startWaitTime < maxStartWait) {
        if (NS.isStillGenerating()) {
          console.log(`✅ ${NS.PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Generation started`);
          generationStarted = true;
          break;
        }
        await NS.waitUnthrottled(10);
      }

      if (!generationStarted) {
        console.log(`⚠️ ${NS.PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Generation did not start, prompt may not have been submitted. Retrying submit...`);

        // Helper to find submit button (including "Make video")
        function findSubmitButton() {
          // First try to find "Make video" button
          const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"]'));
          for (const btn of allButtons) {
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
            const text = (btn.textContent || '').trim().toLowerCase();
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

            // "Make video" IS the submit button!
            if (text.includes('make video') || ariaLabel.includes('make video')) {
              console.log('🔄 Submit retry: Found "Make video" button');
              return btn;
            }
          }

          // Whisk: Check for "Generate" button again for retry
          if (NS.PROVIDER === 'whisk') {
            const actionBtn = NS.findActionButtonNearPrompt(promptInput, NS.ACTION_KEYWORDS);
            if (actionBtn) return actionBtn;
          }

          // Then look for arrow button
          function hasUpwardArrowSvg(el) {
            const svg = el.querySelector('svg');
            if (!svg) return false;
            const path = svg.querySelector('path');
            if (!path) return false;
            const d = path.getAttribute('d') || '';
            return (d.includes('12 5') && d.includes('V19')) ||
              (d.includes('M12') && d.includes('V') && d.includes('L'));
          }

          const allCandidates = document.querySelectorAll('button, div[role="button"], div.rounded-full, [role="button"]');
          for (const el of allCandidates) {
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            const text = (el.textContent || '').trim().toLowerCase();
            const classes = el.className || '';
            const isRounded = classes.includes('rounded');

            // Skip "Redo" - not for new prompts
            if (text === 'redo' || ariaLabel.includes('redo')) continue;

            // Accept aria-label "submit" or "send" or arrow SVG
            if (ariaLabel === 'submit' || ariaLabel.includes('send')) return el;
            if (hasUpwardArrowSvg(el) && isRounded) return el;
          }
          return null;
        }

        // Try to click the submit button
        const retryBtn = findSubmitButton();
        if (retryBtn) {
          console.log(`🔄 ${NS.PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Clicking submit button for retry...`);
          retryBtn.focus();
          retryBtn.click();
        } else {
          // Fallback to Enter key
          console.log(`🔄 ${NS.PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Using Enter key for retry...`);
          promptInput.focus();
          NS.dispatchEnterToSubmit(promptInput);
        }

        // Wait a short time for retry to work
        await NS.waitUnthrottled(500);

        // Check again
        if (!NS.isStillGenerating()) {
          console.log(`⚠️ ${NS.PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Generation still not started after retry, but proceeding to result wait to avoid blocking...`);
          // Don't throw error - proceeding might be safer than effective deadlock
        } else {
          console.log(`✅ ${NS.PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Generation started after retry`);
          generationStarted = true;
        }
      }

      // IMPORTANT: Re-take snapshot AFTER generation starts for Grok
      // This ensures we don't capture stale results from previous sessions
      // IMPORTANT: Re-take snapshot AFTER generation starts
      // This ensures we don't capture stale results from previous sessions
      const postStartElements = NS.collectResultElements();
      const postStartKeys = new Set(postStartElements.map(NS.elementKey).filter(Boolean));
      console.log(`📸 ${NS.PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Post-start snapshot: ${postStartKeys.size} existing result elements`);
      // Update prevKeys to the fresh snapshot
      prevKeys.clear();
      for (const key of postStartKeys) {
        prevKeys.add(key);
      }
    }

    // For Firefly: after triggering, briefly watch for generation to START.
    // - If we detect the "Generating..."/spinner state, re-snapshot so any stale
    //   frame shown during generation is excluded; then we wait for the result.
    // - If a brand-new image appears first (fast generation), stop immediately
    //   and KEEP the pre-click snapshot so that genuine new image stays "new".
    // - If neither is seen, keep the pre-click snapshot (safe default).
    if (NS.PROVIDER === 'firefly') {
      const startWait = Date.now();
      let started = false;
      let newImageAlready = false;
      while (Date.now() - startWait < 10000) {
        if (NS.isStillGenerating()) { started = true; console.log('✅ Firefly: generation started'); break; }
        if (NS.pickBestImageElement(NS.collectResultElements(), prevKeys)) { newImageAlready = true; break; }
        await NS.waitUnthrottled(50);
      }
      if (started && !newImageAlready) {
        const postElems = NS.collectResultElements();
        prevKeys.clear();
        for (const el of postElems) { const k = NS.elementKey(el); if (k) prevKeys.add(k); }
        console.log(`📸 Firefly: post-start snapshot: ${prevKeys.size} existing result elements`);
      } else {
        console.log(`📸 Firefly: keeping pre-click snapshot (started=${started}, newImageAlready=${newImageAlready})`);
      }
    }

    // Wait for the best NEW result (for Meta AI, this will be array of 4 results)
    console.log(`⏳ Waiting for best result ${NS.PROVIDER === 'metaai' ? 'results' : 'image'}...`);
    let best = await NS.waitForNewBestResult(prevKeys, 300000);

    // Check if content was moderated
    if (best && best.moderated) {
      throw new Error('CONTENT_MODERATED: Grok flagged this prompt - skipping to next');
    }

    if (!best) {
      throw new Error(`Timed out waiting for generated ${NS.PROVIDER === 'metaai' ? 'results' : 'images'}`);
    }

    // For Meta AI: handle multiple results (images or videos)
    if (NS.PROVIDER === 'metaai' && Array.isArray(best)) {
      console.log(`📸 Capturing ${best.length} Meta AI results...`);
      const allResultsData = [];

      for (let i = 0; i < best.length; i++) {
        const result = best[i];
        console.log(`📹 Processing result ${i + 1}/${best.length} (${result.tagName})...`);

        // Ensure result is fully loaded before capturing
        if (result.tagName === 'IMG' && !result.complete) {
          console.log(`⏳ Waiting for image ${i + 1} to complete loading...`);
          await new Promise(resolve => {
            result.onload = resolve;
            result.onerror = resolve; // Continue on error
            setTimeout(resolve, 5000); // 5s timeout
          });
        }

        let itemData = null;
        let meta = undefined;

        if (result.tagName === 'VIDEO') {
          const src = result.currentSrc || result.src;
          meta = {
            provider: NS.PROVIDER,
            width: result.videoWidth || result.width || 0,
            height: result.videoHeight || result.height || 0,
            src,
            videoIndex: i + 1,
            totalVideos: best.length,
            type: 'video'
          };
          itemData = await NS.getVideoAsBase64(src, result);
        } else if (result.tagName === 'IMG') {
          const src = result.currentSrc || result.src;
          meta = {
            provider: NS.PROVIDER,
            width: result.naturalWidth || result.width || 0,
            height: result.naturalHeight || result.height || 0,
            src,
            videoIndex: i + 1, // Reuse index for consistency
            totalVideos: best.length,
            type: 'image'
          };
          itemData = await NS.getImageAsBase64(src, result);
        }

        if (itemData) {
          allResultsData.push({ imageData: itemData, meta });
          console.log(`✅ Result ${i + 1} captured`);
        } else {
          console.log(`⚠️ Failed to capture result ${i + 1}`);
        }
      }

      if (allResultsData.length === 0) {
        throw new Error('Failed to capture any Meta AI results');
      }

      console.log(`✅ Successfully captured ${allResultsData.length} Meta AI results`);
      // Use multipleVideos property for backward compatibility with background script, 
      // even though it might contain images
      return { success: true, multipleVideos: allResultsData, itemId: itemId ?? null };

    } else {
      // For other providers: single image/video
      console.log('📸 Capturing best image...');
      let imageData = null;
      let meta = undefined;

      if (best.tagName === 'IMG') {
        const src = best.currentSrc || best.src;
        meta = { provider: NS.PROVIDER, width: best.naturalWidth || best.width || 0, height: best.naturalHeight || best.height || 0, src };

        // For Grok images: use authenticated fetch (images come from imagine-public.x.ai)
        if (NS.PROVIDER === 'grok') {
          console.log('📸 Grok image detected, trying authenticated fetch...');
          try {
            imageData = await NS.getGrokImageAsBase64(src, best);
          } catch (imgError) {
            console.log('⚠️ Grok image capture failed:', imgError.message);
            // Mark as success anyway - image was generated, just couldn't be saved
            return {
              success: true,
              imageData: null,
              itemId: itemId ?? null,
              meta: { ...meta, captureError: 'Image generated but capture failed - please download manually' }
            };
          }
        } else {
          imageData = await NS.getImageAsBase64(src, best);
        }
      } else if (best.tagName === 'CANVAS') {
        meta = { provider: NS.PROVIDER, width: best.width || 0, height: best.height || 0, src: 'canvas' };
        imageData = best.toDataURL('image/png');
      } else if (best.tagName === 'VIDEO') {
        const src = best.currentSrc || best.src;
        meta = { provider: NS.PROVIDER, width: best.videoWidth || best.width || 0, height: best.videoHeight || best.height || 0, src };

        // For Grok videos: capture directly
        if (NS.PROVIDER === 'grok') {
          console.log('📹 Grok video detected, capturing...');
          try {
            imageData = await NS.getGrokVideoAsBase64(src, best);
          } catch (videoError) {
            console.log('⚠️ Grok video capture failed:', videoError.message);
            console.log('ℹ️ Video was generated successfully but could not be saved. Please download manually from the page.');
            return {
              success: true,
              imageData: null,
              itemId: itemId ?? null,
              meta: { ...meta, captureError: 'Video generated but capture failed - please download manually' }
            };
          }
        } else {
          imageData = await NS.getVideoAsBase64(src, best);
        }
      }

      if (!imageData) {
        // For videos, still mark as success if we found the video element
        if (best.tagName === 'VIDEO') {
          console.log('⚠️ Video capture returned null, but video was generated');
          return {
            success: true,
            imageData: null,
            itemId: itemId ?? null,
            meta: { ...meta, captureError: 'Video generated but capture failed' }
          };
        }
        throw new Error('Failed to capture generated image');
      }

      console.log('✅ Best image captured');



      return { success: true, imageData, itemId: itemId ?? null, meta };
    }

  } catch (error) {
    console.error('❌ Generation error:', error);



    return { success: false, error: error.message, itemId: itemId ?? null };
  }
}
  // ── Exports for other content-script module files ──
  NS.generateImageInternal = generateImageInternal;
})();
