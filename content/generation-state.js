// Part of the BulkyGen content script module set — see content.js for the
// injection-guard / namespace-object design this relies on.
(function () {
  if (!window.__BULKYGEN_CS_SHOULD_INIT__) return;
  var NS = window.__BulkyGenCS;



// Helper: Check if the page is still actively generating
function isStillGenerating() {
  // For Grok: check for "Generating" button/text ONLY (NOT upscaling)
  // We capture videos immediately after generation, don't wait for upscale
  if (NS.PROVIDER === 'grok') {
    // Look for elements containing "Generating" text (the button shows "Generating..." during generation)
    const allElements = document.querySelectorAll('button, span, div, p');
    for (const el of allElements) {
      const text = (el.textContent || '').trim().toLowerCase();
      // Match "Generating", "Generating...", "Generating 10%", etc.
      // IMPORTANT: Skip "upscaling" - we handle that separately
      if (text.includes('upscaling')) continue;

      // Check for generating keywords OR percentage indicators
      const isGeneratingText = text.includes('generating');
      const isPercentage = /^\d+%$/.test(text) || /\d+% complete/.test(text); // Matches "10%" or "10% complete"

      if ((isGeneratingText || isPercentage) && text.length < 30) {
        // Make sure it's not a hidden element
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          // Check if this is a small element
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.width < 300) {
            console.log('🔄 Detected generating indicator:', el.tagName, text.slice(0, 30));
            return true;
          }
        }
      }
    }

    // REMOVED: Spinner check for Grok - spinners may indicate upscaling which we skip
    // We only care about the "Generating..." text for initial generation
    // This allows immediate capture as soon as video generates, without waiting for upscale
  }

  // For Meta AI: check for loading indicators
  if (NS.PROVIDER === 'metaai') {
    const loadingIndicators = document.querySelectorAll('[class*="loading"], [class*="spinner"], [aria-busy="true"]');
    if (loadingIndicators.length > 0) {
      return true;
    }
  }

  // For DIGEN AI: ONLY check for disabled generate button (ignore text indicators)
  // The "Generating..." text often lingers even after images appear, so we ignore it
  if (NS.PROVIDER === 'digen') {
    // The star button gets disabled while generating and re-enables when done
    const generateButtons = document.querySelectorAll('button.rounded-full.bg-white:has(svg), button.rounded-full:has(svg)');
    for (const btn of generateButtons) {
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
        console.log('🔄 DIGEN: Generate button is disabled (generating)');
        return true;
      }
    }

    // If button is enabled, generation is complete - ignore any text/spinners
    console.log('✅ DIGEN: Generate button is enabled (ready to capture)');
    return false;
  }

  // For Whisk (ImageFX): check for "Generating..." indicators
  if (NS.PROVIDER === 'whisk') {
    // Check for explicit "Generating..." text in buttons or status indicators
    // The screenshot shows a "Generating..." pill/button
    const indicators = document.querySelectorAll('button, div[role="button"], span, div');
    for (const el of indicators) {
      if (el.shadowRoot) continue; // Skip shadow roots for now to save time

      const text = (el.textContent || '').trim();
      if (text === 'Generating...' || text === 'Generating') {
        // Ensure it's visible
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          // Skip if it is part of the queue history (e.g. "Generating..." label on a past item that failed?)
          // Usually "Generating..." appears at the top or in the active slot
          console.log('🔄 Whisk: Generating indicator found:', el.tagName, text);
          return true;
        }
      }
    }

    // Check for progress bars which often appear during generation
    const progressBars = document.querySelectorAll('[role="progressbar"], [class*="progress-bar"]');
    if (progressBars.length > 0) {
      console.log('🔄 Whisk: Progress bar detected');
      return true;
    }

    // Check for "Stop" button which appears during generation (as seen in screenshot)
    const stopButtons = Array.from(document.querySelectorAll('button')).filter(b =>
      b.textContent && b.textContent.trim().toLowerCase() === 'stop'
    );
    if (stopButtons.length > 0 && stopButtons.some(b => !b.disabled)) {
      console.log('🔄 Whisk: Stop button detected (implies generation active)');
      return true;
    }
  }

  // For Firefly: while a prompt is running it shows a progress/spinner state
  // (and the Generate button enters a busy state). Treat generation as
  // in-progress ONLY while a visible Generating.../spinner/progress indicator
  // is present. We deliberately do NOT use the submit button's disabled state
  // (it is also disabled when the prompt is empty AFTER a generation, which
  // would make the wait loop hang forever).
  if (NS.PROVIDER === 'firefly') {
    const els = document.querySelectorAll('button, [role="button"], span');
    for (const el of els) {
      if (el.shadowRoot) continue;
      const text = (el.textContent || '').trim().toLowerCase();
      if (text === 'generating...' || text === 'generating' || text === 'creating...' || text === 'creating' || text === 'processing...' || text === 'processing') {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            console.log('🔄 Firefly: Generating indicator found:', el.tagName, text.slice(0, 30));
            return true;
          }
        }
      }
    }
    const spin = document.querySelectorAll('[role="progressbar"], [aria-busy="true"], [class*="progress-bar"], [class*="spinner"], [class*="animate-spin"], svg.animate-spin');
    for (const el of spin) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0) {
        console.log('🔄 Firefly: Spinner/progress indicator detected');
        return true;
      }
    }
  }

  return false;
}

// Helper: Check if Grok is currently upscaling
function isGrokUpscaling() {
  if (NS.PROVIDER !== 'grok') return false;

  // Look for "Upscaling" text or loading indicators near the upscale button
  const allElements = document.querySelectorAll('button, span, div, p');
  for (const el of allElements) {
    const text = (el.textContent || '').trim().toLowerCase();
    // Match "Upscaling", "Upscaling...", "Upscaling video"
    if (text.includes('upscaling') && text.length < 30) {
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
        console.log('🔄 Detected upscaling indicator:', el.tagName, text.slice(0, 30));
        return true;
      }
    }
  }

  // Check for loading spinners near the video area
  const spinners = document.querySelectorAll('[class*="animate-spin"], [class*="loading"], [class*="spinner"]');
  for (const spinner of spinners) {
    const style = window.getComputedStyle(spinner);
    if (style.display !== 'none' && style.visibility !== 'hidden') {
      // Check if it's near a video element
      const rect = spinner.getBoundingClientRect();
      const videos = document.querySelectorAll('video');
      for (const video of videos) {
        const videoRect = video.getBoundingClientRect();
        // If spinner is within 200px of video, consider it upscaling
        if (Math.abs(rect.top - videoRect.top) < 200 && Math.abs(rect.left - videoRect.left) < 500) {
          return true;
        }
      }
    }
  }

  return false;
}

// Helper: Find and click Grok's Upscale Video button (including inside menus)
// NOTE: This function is intentionally NOT called during automation.
// Videos are captured immediately after generation WITHOUT waiting for upscale.
// This speeds up bulk generation significantly.
async function clickGrokUpscaleButton() {
  if (NS.PROVIDER !== 'grok') return false;

  console.log('🔍 Grok: Looking for Upscale Video button...');

  // Wait a bit for the video and menu to fully render after generation completes
  await NS.waitUnthrottled(2000);

  // 1. Try finding direct button first (unlikely but check anyway)
  const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"]'));

  for (const btn of allButtons) {
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;

    // Check if button is visible
    const style = window.getComputedStyle(btn);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    const text = (btn.textContent || '').trim().toLowerCase();
    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
    const title = (btn.getAttribute('title') || '').toLowerCase();

    const isUpscaleBtn = text.includes('upscale') || ariaLabel.includes('upscale') || title.includes('upscale');
    const isInProgress = text.includes('upscaling');

    if (isUpscaleBtn && !isInProgress) {
      console.log('✅ Grok: Found direct Upscale Video button:', text || ariaLabel || '[no text]');
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await NS.waitUnthrottled(500);
      btn.focus();
      btn.click();
      console.log('✅ Grok: Upscale Video button clicked');
      return true;
    }
  }

  // 2. Find the 3-dot menu button NEAR THE MOST RECENT VIDEO
  console.log('🔍 Grok: Looking for 3-dot menu near video...');

  // Get all video elements, most recent ones first (by position - lower on page = more recent)
  const videoElements = Array.from(document.querySelectorAll('video'));
  videoElements.sort((a, b) => {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    return rectB.top - rectA.top; // Most recent (lowest on page) first
  });

  // Try to find menu button for the most recent videos
  for (const video of videoElements.slice(0, 3)) {
    console.log('🎬 Grok: Checking video at position:', video.getBoundingClientRect().top);

    // First, try to hover over the video to make the menu button appear
    video.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    video.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await NS.waitUnthrottled(500);

    // Walk up the DOM to find the container with the menu button
    let container = video.parentElement;
    for (let level = 0; level < 10 && container; level++) {
      // Look for buttons that could be the 3-dot menu
      const btns = container.querySelectorAll('button, [role="button"]');

      for (const btn of btns) {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const text = (btn.textContent || '').trim();
        const hasSvg = btn.querySelector('svg');

        // Skip if disabled or hidden
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        // Check for 3-dot menu indicators (including SVG with 3 circles/dots)
        const svgContent = btn.innerHTML.toLowerCase();
        const hasDotsSvg = hasSvg && (
          svgContent.includes('circle') ||
          svgContent.includes('ellipse') ||
          (svgContent.match(/circle/g) || []).length >= 2 ||
          svgContent.includes('...') ||
          svgContent.includes('more')
        );

        const isDotMenu =
          aria.includes('option') ||
          aria.includes('more') ||
          aria.includes('menu') ||
          text === '...' ||
          text === '⋮' ||
          text === '•••' ||
          hasDotsSvg;

        if (isDotMenu) {
          console.log('🖱️ Grok: Found menu button:', aria || text || '[dots]', 'at level', level);

          // Scroll into view and click
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await NS.waitUnthrottled(300);
          btn.click();

          // Wait for dropdown to render (longer wait for reliability)
          await NS.waitUnthrottled(500);

          // Search for "Upscale video" in the dropdown
          const upscaleFound = await findAndClickUpscaleInMenu();

          if (upscaleFound) {
            return true;
          }

          // Menu didn't have upscale - close and try next
          console.log('🔍 Grok: Upscale not in this menu, trying next...');
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await NS.waitUnthrottled(200);
        }
      }
      container = container.parentElement;
    }
  }

  console.log('⚠️ Grok: Upscale Video button not found');
  return false;
}

// Helper: Find and click Upscale option in currently open menu
async function findAndClickUpscaleInMenu() {
  console.log('🔍 Grok: Searching for Upscale option in open menu...');

  // Wait a bit more for the menu to fully render
  await NS.waitUnthrottled(300);

  // Get ALL clickable elements that might be menu items
  const allClickables = document.querySelectorAll(
    'button, div[role="button"], [role="menuitem"], [role="option"], ' +
    '[data-radix-collection-item], [class*="menu-item"], [class*="MenuItem"], ' +
    '[class*="dropdown"] > *, [class*="popover"] > *, li, a'
  );

  // Also look for menu containers and their direct children
  const menuContainers = document.querySelectorAll('[role="menu"], [class*="dropdown"], [class*="popover"], [class*="menu"]');
  const menuItems = [];

  // Collect items from menu containers
  for (const menu of menuContainers) {
    const style = window.getComputedStyle(menu);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const children = menu.querySelectorAll('button, div, span, li, a');
    for (const child of children) {
      menuItems.push(child);
    }
  }

  // Combine all potential menu items
  const allItems = [...allClickables, ...menuItems];

  // First pass: look for exact "Upscale video" text
  for (const item of allItems) {
    const text = (item.textContent || '').trim().toLowerCase();

    // Check visibility
    const rect = item.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const style = window.getComputedStyle(item);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    // Match "upscale video" exactly (the 5th menu option)
    if (text.includes('upscale video')) {
      // Skip if it's the generating/in-progress state
      if (text.includes('upscaling')) continue;

      // Check if disabled
      if (item.getAttribute('aria-disabled') === 'true') {
        console.log('⚠️ Grok: Upscale option found but disabled');
        continue;
      }

      console.log('✅ Grok: Found Upscale option:', text);
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await NS.waitUnthrottled(200);
      item.click();
      console.log('✅ Grok: Upscale menu item clicked');
      return true;
    }
  }

  // Second pass: look for just "upscale" (in case text is slightly different)
  for (const item of allItems) {
    const text = (item.textContent || '').trim().toLowerCase();

    // Check visibility
    const rect = item.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const style = window.getComputedStyle(item);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    // Match "upscale" keyword
    if (text.includes('upscale') && !text.includes('upscaling')) {
      // Check if disabled
      if (item.getAttribute('aria-disabled') === 'true') {
        console.log('⚠️ Grok: Upscale option found but disabled');
        continue;
      }

      console.log('✅ Grok: Found Upscale option (second pass):', text);
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await NS.waitUnthrottled(200);
      item.click();
      console.log('✅ Grok: Upscale menu item clicked');
      return true;
    }
  }

  console.log('⚠️ Grok: Upscale option not found in menu');
  return false;
}

// Helper: Wait for Grok upscale to complete
// NOTE: This function is intentionally NOT called during automation.
// Videos are captured immediately after generation WITHOUT waiting for upscale.
async function waitForGrokUpscaleComplete(timeoutMs = 300000) {
  if (NS.PROVIDER !== 'grok') return true;

  console.log('⏳ Grok: Waiting for upscale to complete (timeout: ' + (timeoutMs / 1000) + 's)...');
  const start = Date.now();
  let lastLogTime = 0;

  // First wait for upscaling to start (button text changes to "Upscaling...")
  let upscaleStarted = false;
  const startWaitTime = Date.now();
  while (Date.now() - startWaitTime < 10000) { // Wait up to 10s for upscale to start
    if (isGrokUpscaling()) {
      console.log('✅ Grok: Upscaling started');
      upscaleStarted = true;
      break;
    }
    await NS.waitUnthrottled(200);
  }

  if (!upscaleStarted) {
    console.log('⚠️ Grok: Upscaling indicator not detected (may already be processing)');
    // Still wait some time in case upscaling is happening without visible indicator
    await NS.waitUnthrottled(5000);
  }

  // Wait for upscaling to complete (no more "Upscaling" indicator)
  let stableCount = 0;
  const requiredStableChecks = 5; // Require 5 consecutive stable checks (2.5 seconds)

  while (Date.now() - start < timeoutMs) {
    const stillUpscaling = isGrokUpscaling();
    const stillGenerating = isStillGenerating();

    // Log progress every 10 seconds
    if (Date.now() - lastLogTime > 10000) {
      console.log(`🔄 Grok upscale: upscaling=${stillUpscaling}, generating=${stillGenerating}, elapsed=${Math.round((Date.now() - start) / 1000)}s`);
      lastLogTime = Date.now();
    }

    if (!stillUpscaling && !stillGenerating) {
      stableCount++;
      // Wait for multiple consecutive checks to ensure stable
      if (stableCount >= requiredStableChecks) {
        console.log('✅ Grok: Upscale complete');
        // Wait additional time for the upscaled video to fully load
        console.log('⏳ Grok: Waiting for upscaled video to load...');
        await NS.waitUnthrottled(3000);
        return true;
      }
    } else {
      stableCount = 0;
    }

    await NS.waitUnthrottled(500);
  }

  console.log('⚠️ Grok: Upscale timeout reached, proceeding anyway...');
  return false;
}

// Helper: Wait for loading to complete
async function waitForGenerationComplete() {
  console.log('⏳ Waiting for generation to complete...');

  return new Promise((resolve) => {
    let checkCount = 0;
    const maxChecks = 60; // 60 seconds max wait
    let initialImageCount = document.querySelectorAll('img').length;

    // Also count images in shadow DOM
    function countAllImages() {
      let count = document.querySelectorAll('img').length;

      function countInShadow(root) {
        const elements = root.querySelectorAll('*');
        for (const el of elements) {
          if (el.shadowRoot) {
            count += el.shadowRoot.querySelectorAll('img').length;
            countInShadow(el.shadowRoot);
          }
        }
      }

      countInShadow(document);
      return count;
    }

    initialImageCount = countAllImages();
    console.log('📊 Initial image count:', initialImageCount);

    const checkInterval = setInterval(() => {
      checkCount++;

      // Check if new images have been added (generation complete)
      const currentImageCount = countAllImages();

      if (currentImageCount > initialImageCount) {
        clearInterval(checkInterval);
        console.log('✅ Generation complete! New image detected. Image count:', currentImageCount);
        console.log('⏳ Waiting 3 seconds for image to fully load...');
        setTimeout(resolve, 3000);
        return;
      }

      if (checkCount % 5 === 0) {
        console.log(`Check ${checkCount}: Images=${currentImageCount} (waiting for > ${initialImageCount})`);
      }

      // Timeout fallback
      if (checkCount >= maxChecks) {
        clearInterval(checkInterval);
        console.log('⚠️ Max wait time reached, proceeding anyway...');
        setTimeout(resolve, 2000);
      }
    }, 1000);
  });
}

// Wait for Whisk UI to fully load before generating
function waitForProviderUI() {
  return new Promise((resolve) => {
    console.log(`🔍 Watching for UI elements (${NS.PROVIDER})...`);

    function logUiDiagnostics() {
      const mainTextareas = document.querySelectorAll('textarea').length;
      const mainRoleTextboxes = document.querySelectorAll('[role="textbox"]').length;
      const mainContentEditable = document.querySelectorAll('[contenteditable="true"]').length;
      const submitButtons = document.querySelectorAll('button[type="submit"]').length;

      console.log(`🧩 UI diagnostics (${NS.PROVIDER}):`, {
        mainTextareas,
        mainRoleTextboxes,
        mainContentEditable,
        submitButtons
      });
    }

    // Function to check if UI is ready
    function checkIfReady() {
      // Find prompt input (textarea OR contenteditable OR role=textbox etc) using shadow-DOM aware lookup
      const promptEl = NS.findElement(NS.SELECTORS.promptInput);
      const hasPromptInput = !!promptEl;

      const isConv = NS.isFlowConversationPage();

      // For Flow: only require the textarea. The arrow/generate button is searched
      // dynamically inside NS.submitFlowPrompt() using proximity-based heuristics.
      if (NS.PROVIDER === 'flow') {
        if (hasPromptInput) {
          console.log(`✅ UI detected and ready! (${NS.PROVIDER}) - textarea found`);
        }
        return hasPromptInput;
      }

      // Find action button (main DOM or shadow DOM) OR locate submit near the prompt
      const actionEl = NS.findElement(NS.SELECTORS.actionButton) || NS.findActionButtonNearPrompt(promptEl, NS.ACTION_KEYWORDS);
      const hasActionButton = !!actionEl;

      // Other providers need both input and action button.
      const isReady = hasPromptInput && (hasActionButton || isConv);

      if (isReady) {
        console.log(`✅ UI detected and ready! (${NS.PROVIDER})`);
        console.log('  - Prompt input:', hasPromptInput);
        console.log('  - Action button:', hasActionButton);
      }

      return isReady;
    }

    // Check immediately first
    if (checkIfReady()) {
      resolve(true);
      return;
    }

    // Set up MutationObserver to watch for shadow DOM changes
    const observer = new MutationObserver((mutations) => {
      if (checkIfReady()) {
        observer.disconnect();
        resolve(true);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false
    });

    // Safety timeout to prevent permanent hang
    setTimeout(() => {
      console.warn('⚠️ UI detection safety timeout triggered.\nForcing continuation to pinpoint error...');
      observer.disconnect();
      resolve(true);
    }, 12000);

    // Also force check periodically (kept light to avoid interfering with Whisk boot)
    let checkCount = 0;
    const intervalMs = 250;
    const timeoutMs = NS.PROVIDER === 'flow' ? 30000 : 15000;
    const maxChecks = Math.ceil(timeoutMs / intervalMs);

    function periodicCheck() {
      checkCount++;

      if (checkIfReady()) {
        observer.disconnect();
        resolve(true);
        return;
      }

      if (checkCount >= maxChecks) {
        observer.disconnect();
        console.log(`⚠️ UI not detected after ${Math.round(timeoutMs / 1000)}s (${NS.PROVIDER})`);
        logUiDiagnostics();
        resolve(false);
        return;
      }

      // Continue checking
      setTimeout(periodicCheck, intervalMs);
    }

    // Start periodic checks
    setTimeout(periodicCheck, intervalMs);
  });
}

// Debug function to inspect actual DOM
function debugDOM() {
  console.log('=== DOM NS.DEBUG ===');
  console.log('All buttons on page:', document.querySelectorAll('button').length);
  console.log('All textareas on page:', document.querySelectorAll('textarea').length);
  console.log('All inputs on page:', document.querySelectorAll('input').length);
  console.log('All divs on page:', document.querySelectorAll('div').length);

  // Check shadow roots and their contents
  let shadowCount = 0;
  let buttonsInShadow = 0;
  let textareasInShadow = 0;

  function searchShadowDOM(root, depth = 0) {
    const elements = root.querySelectorAll('*');
    elements.forEach(el => {
      if (el.shadowRoot) {
        shadowCount++;
        // Count elements in this shadow root
        const shadowButtons = el.shadowRoot.querySelectorAll('button');
        const shadowTextareas = el.shadowRoot.querySelectorAll('textarea');
        buttonsInShadow += shadowButtons.length;
        textareasInShadow += shadowTextareas.length;

        if (shadowButtons.length > 0) {
          console.log(`Found ${shadowButtons.length} buttons in shadow DOM (depth ${depth}):`,
            Array.from(shadowButtons).slice(0, 3).map(b => b.textContent.trim().substring(0, 40)));
        }
        if (shadowTextareas.length > 0) {
          console.log(`Found ${shadowTextareas.length} textareas in shadow DOM (depth ${depth})`);
        }

        // Recursively search nested shadow DOMs
        searchShadowDOM(el.shadowRoot, depth + 1);
      }
    });
  }

  searchShadowDOM(document);

  console.log('Elements with shadow DOM:', shadowCount);
  console.log('Buttons in shadow DOMs:', buttonsInShadow);
  console.log('Textareas in shadow DOMs:', textareasInShadow);

  // Log first 5 buttons with their text
  const buttons = Array.from(document.querySelectorAll('button')).slice(0, 10);
  console.log('First 10 buttons in main DOM:', buttons.map(b => ({
    text: b.textContent.trim().substring(0, 30),
    class: b.className
  })));

  console.log('=================');
}
  // ── Exports for other content-script module files ──
  NS.isStillGenerating = isStillGenerating;
  NS.clickGrokUpscaleButton = clickGrokUpscaleButton;
  NS.waitForGrokUpscaleComplete = waitForGrokUpscaleComplete;
  NS.waitForProviderUI = waitForProviderUI;
})();
