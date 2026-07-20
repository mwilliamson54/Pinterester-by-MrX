// Marker so the side panel / background never double-inject this script.
window.__BULKYGEN_CS_LOADED__ = true;
// Stop re-evaluation before const/let redeclarations throw. ensureTabContentScript
// treats this specific error as "already present" (success).
if (window.__BULKYGEN_CS_FULLY_INIT__) {
  throw new Error('BULKYGEN_CS_ALREADY_INIT');
}
window.__BULKYGEN_CS_FULLY_INIT__ = true;

// Content script for Whisk + other platforms automation

// Cross-browser extension API (Firefox/Safari use `browser`, Chrome/Edge use `chrome`)
// ext.js defines `globalThis.ext`; keep a local fallback just in case.
const ext = globalThis.ext || globalThis.browser || globalThis.chrome;

function detectProvider() {
  try {
    const url = new URL(window.location.href);
    const host = (url.hostname || '').toLowerCase();
    const path = url.pathname || '';

    if (host === 'labs.google' && path.startsWith('/fx/tools/flow/project/')) return 'flow';
    if ((host === 'meta.ai' || host === 'www.meta.ai') && path.includes('/media')) return 'metaai';
    if (host === 'grok.com' && path.startsWith('/imagine')) return 'grok';
    if (host === 'digen.ai') return 'digen';
    if ((host === 'gentube.app' || host === 'www.gentube.app') && path.startsWith('/create')) return 'gentube';
    if (host === 'firefly.adobe.com' && path.startsWith('/generate')) return 'firefly';
    return 'unknown';
  } catch {
    const href = window.location.href || '';
    if (href.startsWith('https://labs.google/fx/tools/flow/project/')) return 'flow';
    if (href.includes('meta.ai') && href.includes('/media')) return 'metaai';
    if (href.includes('grok.com') && href.includes('/imagine')) return 'grok';
    if (href.includes('digen.ai')) return 'digen';
    if (href.includes('gentube.app') && href.includes('/create')) return 'gentube';
    if (href.includes('firefly.adobe.com') && href.includes('/generate')) return 'firefly';
    return 'unknown';
  }
}

const PROVIDER = detectProvider();
console.log(`BulkyGen: Content script loaded (provider=${PROVIDER})`);

// Push a diagnostic to the background service worker so it lands in the same
// exportable log the settings page shows — this content script's own
// console.log() calls only ever appear in THIS tab's DevTools console, never
// in the service worker inspector or the exported log, which is why Flow
// failures (composer/button not found, etc.) used to look like total silence.
function clientLog(level, tag, message) {
  try {
    (globalThis.chrome || ext).runtime.sendMessage({ action: 'clientLog', level, tag, message });
  } catch (e) { /* ignore */ }
}

// --- In-page right sidebar (cross-browser) ---

const BULKYGEN_PANEL_ID = 'bulkygen-right-panel';

function ensurePanel() {
  let host = document.getElementById(BULKYGEN_PANEL_ID);
  if (host) return host;

  host = document.createElement('div');
  host.id = BULKYGEN_PANEL_ID;
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.right = '0';
  host.style.height = '100vh';
  host.style.width = '420px';
  host.style.maxWidth = '95vw';
  host.style.zIndex = '2147483647';
  host.style.display = 'none';
  host.style.background = 'transparent';
  host.style.borderLeft = '1px solid rgba(0,0,0,0.2)';

  const iframe = document.createElement('iframe');
  iframe.title = 'BulkyGen';
  iframe.src = (ext?.runtime?.getURL ? ext.runtime.getURL('popup.html') : null) || '';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.style.background = 'transparent';
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
  host.appendChild(iframe);

  document.documentElement.appendChild(host);
  return host;
}

function setPanelVisible(visible) {
  const panel = ensurePanel();
  panel.style.display = visible ? 'block' : 'none';
}

function togglePanel() {
  const panel = ensurePanel();
  const isVisible = panel.style.display !== 'none';
  setPanelVisible(!isVisible);
}

// Pre-create the hidden panel on supported pages for faster first open.
// (Does not display anything until the user clicks the extension icon.)
if (PROVIDER !== 'unknown') {
  try {
    setTimeout(() => {
      try { ensurePanel(); } catch { /* ignore */ }
    }, 250);
  } catch {
    // ignore
  }
}

// Listen for close requests from the iframe UI
window.addEventListener('message', (event) => {
  const data = event?.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'BULKYGEN_CLOSE_PANEL') {
    setPanelVisible(false);
  }
});

function isFlowConversationPage() {
  if (PROVIDER !== 'flow') return false;
  return false;
}

function dispatchEnterToSubmit(target) {
  if (!target) return;

  // Enhanced options for React/ProseMirror/Shadow DOM compatibility
  const opts = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true, // Allows event to cross Shadow DOM boundaries
    view: window
  };

  // Create and dispatch keyboard events
  const keydownEvent = new KeyboardEvent('keydown', opts);
  const keypressEvent = new KeyboardEvent('keypress', opts);
  const keyupEvent = new KeyboardEvent('keyup', opts);

  // Dispatch events in sequence
  target.dispatchEvent(keydownEvent);
  target.dispatchEvent(keypressEvent);
  target.dispatchEvent(keyupEvent);

  // Additionally trigger an InputEvent for contenteditable (ProseMirror)
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') {
    try {
      target.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertParagraph',
        data: null
      }));
    } catch (e) {
      // InputEvent may not be fully supported
    }
  }

  // Fallback: Try to find and submit the closest form
  const form = target.closest('form');
  if (form) {
    try {
      // Look for submit button in form
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn && !submitBtn.disabled) {
        console.log('🔄 Fallback: clicking form submit button');
        submitBtn.click();
      }
    } catch (e) {
      // Ignore
    }
  }
}

const DEBUG = false;
function debugLog(...args) {
  if (DEBUG) console.log(...args);
}

const PROVIDERS = {
  flow: {
    id: 'flow',
    label: 'Flow',
    selectors: {
      promptInput: [
        'textarea[placeholder*="what do you want to create" i]',
        'textarea[placeholder*="create" i]',
        'textarea',
        'div[contenteditable="true"]',
        'div[role="textbox"]'
      ],
      actionButton: [
        'button[aria-label*="generate" i]',
        'button[aria-label*="create" i]',
        'button[aria-label*="send" i]',
        'button[type="submit"]',
        'button:has(svg)',
        '[role="button"][aria-label*="generate" i]',
        '[role="button"][aria-label*="send" i]',
        '[role="button"]'
      ],
      imageContainer: [
        'img[src^="blob:"]',
        'img[src^="https://"]',
        'canvas',
        'video'
      ]
    },
    actionKeywords: ['generate', 'create', 'send', 'run', 'start'],
    submitViaEnter: false,
    clickSubmitButton: true,
    requiredModelText: 'nano banana'
  },
  metaai: {
    id: 'metaai',
    label: 'Meta AI',
    selectors: {
      promptInput: [
        '[contenteditable="true"]',
        'div[contenteditable="true"]',
        'div[role="textbox"]',
        'textarea',
        '[placeholder*="describe" i]',
        '[placeholder*="image" i]',
        '[aria-label*="message" i]'
      ],
      actionButton: [
        'div[role="button"][aria-label*="Send" i]',
        'button[aria-label*="Send" i]',
        'div[role="button"]',
        'button[type="submit"]',
        'button'
      ],
      imageContainer: [
        'video[src*="scontent" i]',
        'video[src*="fbcdn" i]',
        'video[src*="fbsbx" i]',
        'video[src^="blob:"]',
        'video',
        'img[src*="scontent" i]',
        'img[src*="fbcdn" i]',
        'img[src*="fbsbx" i]',
        'img[src^="blob:"]',
        'img[src^="https://" i]',
        'img[alt*="generated" i]',
        'img[alt*="image" i]',
        'canvas'
      ]
    },
    actionKeywords: ['send', 'submit', ''],
    submitViaEnter: false,
    clickSubmitButton: true
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    selectors: {
      promptInput: [
        '[contenteditable="true"]', // Prioritize contenteditable (ProseMirror)
        'div[className*="ProseMirror"]',
        'div[role="textbox"]',
        '[placeholder*="imagine" i]',
        'textarea',
        'input[type="text"]',
        '[placeholder*="type" i]',
        '[placeholder*="prompt" i]',
        '[aria-label*="prompt" i]',
        '[aria-label*="imagine" i]',
        '[data-testid*="prompt" i]',
        '[data-testid*="input" i]'
      ],
      actionButton: [
        'button[type="submit"]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="Submit" i]',
        'button[aria-label*="Generate" i]',
        'div[role="button"][aria-label*="Send" i]',
        'div[role="button"]',
        'button'
      ],
      imageContainer: [
        'img[src*="twimg" i]',
        'img[src^="blob:"]',
        'img[src^="data:image" i]',
        'img[src^="https://" i]',
        'img[alt*="generated" i]',
        'img[alt*="image" i]',
        'video[src*="twimg" i]',
        'video[src^="blob:"]',
        'video',
        'canvas'
      ]
    },
    actionKeywords: ['send', 'submit', 'generate', ''],
    submitViaEnter: false,
    clickSubmitButton: true
  },
  digen: {
    id: 'digen',
    label: 'DIGEN AI',
    selectors: {
      promptInput: [
        'textarea',
        'input[type="text"]',
        '[placeholder*="Type your ideas" i]',
        '[placeholder*="ideas" i]',
        'div[contenteditable="true"]',
        'div[role="textbox"]',
        '[placeholder*="prompt" i]',
        '[placeholder*="describe" i]'
      ],
      actionButton: [
        'button.rounded-full.bg-white:has(svg)',  // Circular white button with star/sparkle icon
        'button.rounded-full:has(svg)',
        'button.bg-white:has(svg)',
        'button.size-9:has(svg)',
        'button[type="submit"]',
        'button[aria-label*="Generate" i]',
        'button[aria-label*="Create" i]',
        'button:has(svg)',
        '[role="button"]:has(svg)',
        'button'
      ],
      imageContainer: [
        'img[src^="blob:"]',
        'img[src^="https://"]',
        'img[alt*="generated" i]',
        'img[alt*="result" i]',
        'video[src^="blob:"]',
        'video[src^="https://"]',
        'video',
        'canvas'
      ]
    },
    actionKeywords: ['generate', 'create', 'submit'],
    submitViaEnter: false,
    clickSubmitButton: true
  },
  gentube: {
    id: 'gentube',
    label: 'Gentube',
    selectors: {
      promptInput: [
        'textarea[placeholder*="type to create" i]',
        '[contenteditable="true"][aria-label*="type to create" i]',
        'div[role="textbox"][aria-label*="type to create" i]',
        'textarea',
        'div[contenteditable="true"]',
        'div[role="textbox"]',
        '[placeholder*="prompt" i]',
        '[placeholder*="describe" i]',
        '[placeholder*="create" i]',
        '[aria-label*="prompt" i]',
        '[aria-label*="create" i]',
        '[data-testid*="prompt" i]'
      ],
      actionButton: [
        'button[type="submit"]',
        'button[aria-label*="Generate" i]',
        'button[aria-label*="Create" i]',
        'button[aria-label*="Send" i]',
        '[role="button"][aria-label*="Generate" i]',
        'button:has(svg)',
        '[role="button"]'
      ],
      imageContainer: [
        'img[src^="blob:"]',
        'img[src^="data:image"]',
        'img[src^="https://"]',
        'img[alt*="generated" i]',
        'img[alt*="result" i]',
        'video[src^="blob:"]',
        'video[src^="https://"]',
        'video',
        'canvas'
      ]
    },
  },
  firefly: {
    id: 'firefly',
    label: 'Firefly',
    selectors: {
      promptInput: [
        'textarea[placeholder*="create" i]',
        'textarea[placeholder*="prompt" i]',
        'textarea[placeholder*="describe" i]',
        'textarea',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'div[role="textbox"]',
        '[placeholder*="prompt" i]',
        '[placeholder*="describe" i]',
        '[placeholder*="create" i]',
        '[aria-label*="prompt" i]',
        '[aria-label*="create" i]',
        '[data-testid*="prompt" i]'
      ],
      actionButton: [
        'button[aria-label*="Generate" i]',
        'button[data-testid*="generate" i]',
        'button[data-test-id*="generate" i]',
        'button[id*="generate" i]',
        'button[class*="generate" i]',
        'button[type="submit"]',
        '[role="button"][aria-label*="Generate" i]',
        'button[aria-label*="Create" i]',
        'button[aria-label*="Send" i]',
        '[role="button"][aria-label*="Create" i]'
      ],
      imageContainer: [
        'img[src^="blob:"]',
        'img[src^="data:image"]',
        'img[src^="https://"]',
        'img[alt*="generated" i]',
        'img[alt*="result" i]',
        'video[src^="blob:"]',
        'video[src^="https://"]',
        'video',
        'canvas'
      ]
    },
    actionKeywords: ['generate', 'create', 'send', 'submit', 'run'],
    submitViaEnter: false,
    clickSubmitButton: true
  }
};

const SELECTORS = (PROVIDERS[PROVIDER] || PROVIDERS.flow).selectors;
const ACTION_KEYWORDS = (PROVIDERS[PROVIDER] || PROVIDERS.flow).actionKeywords;

let hasLoggedInventory = false;

function findGentubePromptInput() {
  const allTextareas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'));
  if (!allTextareas.length) return null;

  // 1. Direct placeholder match for exactly what user provided
  for (const el of allTextareas) {
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if (placeholder.includes('type to create') || aria.includes('type to create') || placeholder.includes('✨')) {
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden') return el;
    }
  }

  // 2. Visible scoring fallback
  let best = null;
  let bestScore = -1;
  for (const el of allTextareas) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 10) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if (placeholder.includes('search') || aria.includes('search')) continue;

    let score = 0;
    if (el.tagName.toLowerCase() === 'textarea') score += 100;
    if (placeholder.includes('create') || aria.includes('create')) score += 80;

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function logButtonInventoryOnce() {
  if (hasLoggedInventory) return;
  hasLoggedInventory = true;

  const seen = new Set();
  const buttons = [];

  function pushButton(el) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    const ariaLabel = (el.getAttribute?.('aria-label') || '').trim();
    const type = (el.type || el.getAttribute?.('type') || '').toString();
    const disabled = !!el.disabled || el.getAttribute?.('aria-disabled') === 'true';
    buttons.push({ text: text.slice(0, 80), ariaLabel: ariaLabel.slice(0, 80), type, disabled });
  }

  function scan(root) {
    try {
      root.querySelectorAll('button,[role="button"]').forEach(pushButton);
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) scan(el.shadowRoot);
      });
    } catch {
      // ignore
    }
  }

  scan(document);
  console.log(`🔎 UI inventory (${PROVIDER}): found ${buttons.length} buttons (including shadow DOM)`);
  console.log('🔎 First 20 buttons:', buttons.slice(0, 20));
}

function normalizeText(value) {
  return (value || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

function findActionButtonNearPrompt(promptEl, keywords) {
  if (!promptEl) return null;

  const root = promptEl.getRootNode?.() || document;
  const form = promptEl.closest?.('form') || null;
  const scope = form || (promptEl.closest?.('main,section,div') || root);

  const candidates = [];
  try {
    scope.querySelectorAll('button,[role="button"]').forEach(el => candidates.push(el));
  } catch {
    return null;
  }

  const keywordsNorm = (keywords || []).map(normalizeText).filter(Boolean);

  const scored = candidates
    .map(el => {
      const text = normalizeText(el.textContent);
      const aria = normalizeText(el.getAttribute?.('aria-label'));
      const title = normalizeText(el.getAttribute?.('title'));
      const type = normalizeText(el.type || el.getAttribute?.('type'));
      const disabled = !!el.disabled || el.getAttribute?.('aria-disabled') === 'true';

      // Skip obvious non-generate buttons
      if (text.includes('add images') || aria.includes('add images')) return null;
      if (text.includes('add') && text.includes('images')) return null;
      if (disabled) return null;

      let score = 0;
      if (type === 'submit') score += 50;

      // Score by keyword presence (provider-specific)
      for (const kw of keywordsNorm) {
        if (!kw) continue;
        if (aria.includes(kw) || text.includes(kw) || title.includes(kw)) {
          // Prefer exact common actions higher
          if (kw === 'generate') score += 100;
          else if (kw === 'create') score += 90;
          else if (kw === 'start') score += 90;
          else if (kw === 'run') score += 50;
          else score += 30;
        }
      }
      // Icon-only buttons (arrow) often have no text; give a small bump if it's submit.
      if (!text && type === 'submit') score += 10;

      // Up-arrow / send icon (common submit affordance), even when type isn't "submit".
      // Matches the Solar "arrow-up" path used by some send/submit UIs.
      try {
        const __svgD = el.querySelector?.('svg path')?.getAttribute('d') || '';
        if (!text && /M12\s*20V4/.test(__svgD)) score += 120;
      } catch (e) { /* ignore */ }

      return score > 0 ? { el, score, text, aria, title, type } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.el || null;
}

// Helper: Find element including shadow DOM and iframes
function findElement(selectors) {
  // Handle both array and string selectors
  const selectorList = Array.isArray(selectors) ? selectors : selectors.split(',').map(s => s.trim());

  // Function to search including shadow roots
  function searchInTree(root, selector) {
    // Try in current root
    try {
      if (selector.includes(':has-text')) {
        const [baseSelector, text] = selector.split(':has-text');
        const textMatch = text.match(/\("(.+)"\)/);
        if (textMatch) {
          const searchText = textMatch[1];
          const elements = root.querySelectorAll(baseSelector.trim() || 'button');
          for (const el of elements) {
            if (el.textContent.toLowerCase().includes(searchText.toLowerCase())) {
              return el;
            }
          }
        }
      } else {
        const el = root.querySelector(selector);
        if (el) {
          debugLog('Found element with selector:', selector);
          return el;
        }
      }
    } catch (e) {
      // Invalid selector
    }

    // Search in shadow roots
    const allElems = root.querySelectorAll('*');
    for (const element of allElems) {
      if (element.shadowRoot) {
        const result = searchInTree(element.shadowRoot, selector);
        if (result) return result;
      }
    }

    return null;
  }

  // Try each selector
  for (const selector of selectorList) {
    const result = searchInTree(document, selector);
    if (result) return result;

    // Also try in iframes
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (iframeDoc) {
          const result = searchInTree(iframeDoc, selector);
          if (result) return result;
        }
      } catch (e) {
        // Cross-origin iframe, skip
      }
    }
  }

  return null;
}

// Helper: Background-safe wait.
// requestAnimationFrame is frozen while the tab is hidden, which used to stall
// the whole pipeline the moment you switched tabs. We now also arm a real timer
// (kept alive by the silent-audio keep-alive) so waits resolve EVEN when the
// tab is in the background -- generation keeps running off-tab. rAF is still
// used for precise, smooth timing while the tab is visible.
function waitUnthrottled(ms) {
  return new Promise(resolve => {
    let done = false;
    const start = performance.now();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    // Timer path: fires even when the tab is hidden/backgrounded.
    const timer = setTimeout(finish, ms);
    // rAF path: precise timing while visible; skipped automatically when hidden.
    function check() {
      if (done) return;
      if (performance.now() - start >= ms) {
        finish();
      } else if (!document.hidden) {
        requestAnimationFrame(check);
      }
    }
    requestAnimationFrame(check);
  });
}

// Helper: Wait for element
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const element = findElement(selector);
    if (element) return resolve(element);

    const observer = new MutationObserver(() => {
      const element = findElement(selector);
      if (element) {
        observer.disconnect();
        resolve(element);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    setTimeout(() => {
      observer.disconnect();
      const selectorStr = Array.isArray(selector) ? selector.join(', ') : selector;
      reject(new Error('Element not found: ' + selectorStr));
    }, timeout);
  });
}

// Helper: Check if Grok flagged content as moderated/blocked
function isContentModerated() {
  if (PROVIDER !== 'grok') return false;

  // Look for content moderation messages
  const allText = document.body?.innerText?.toLowerCase() || '';
  const moderationPhrases = [
    'content policy',
    'content moderation',
    'cannot generate',
    'unable to generate',
    'violates our',
    'against our policies',
    'inappropriate content',
    'not allowed',
    'blocked',
    'safety guidelines',
    'harmful content',
    'try a different prompt',
    'please try again with a different',
    'we can\'t create',
    'i can\'t generate'
  ];

  for (const phrase of moderationPhrases) {
    if (allText.includes(phrase)) {
      console.log('⚠️ Grok: Content moderation detected:', phrase);
      return true;
    }
  }

  // Also check for error/warning banners
  const errorElements = document.querySelectorAll('[role="alert"], [class*="error"], [class*="warning"], [class*="danger"]');
  for (const el of errorElements) {
    const text = (el.textContent || '').toLowerCase();
    if (text.length > 10 && text.length < 500) {
      for (const phrase of moderationPhrases) {
        if (text.includes(phrase)) {
          console.log('⚠️ Grok: Content moderation banner detected:', phrase);
          return true;
        }
      }
    }
  }

  return false;
}

// Helper: Check if the page is still actively generating
function isStillGenerating() {
  // For Grok: check for "Generating" button/text ONLY (NOT upscaling)
  // We capture videos immediately after generation, don't wait for upscale
  if (PROVIDER === 'grok') {
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
  if (PROVIDER === 'metaai') {
    const loadingIndicators = document.querySelectorAll('[class*="loading"], [class*="spinner"], [aria-busy="true"]');
    if (loadingIndicators.length > 0) {
      return true;
    }
  }

  // For DIGEN AI: ONLY check for disabled generate button (ignore text indicators)
  // The "Generating..." text often lingers even after images appear, so we ignore it
  if (PROVIDER === 'digen') {
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
  if (PROVIDER === 'whisk') {
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
  if (PROVIDER === 'firefly') {
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
  if (PROVIDER !== 'grok') return false;

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
  if (PROVIDER !== 'grok') return false;

  console.log('🔍 Grok: Looking for Upscale Video button...');

  // Wait a bit for the video and menu to fully render after generation completes
  await waitUnthrottled(2000);

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
      await waitUnthrottled(500);
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
    await waitUnthrottled(500);

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
          await waitUnthrottled(300);
          btn.click();

          // Wait for dropdown to render (longer wait for reliability)
          await waitUnthrottled(500);

          // Search for "Upscale video" in the dropdown
          const upscaleFound = await findAndClickUpscaleInMenu();

          if (upscaleFound) {
            return true;
          }

          // Menu didn't have upscale - close and try next
          console.log('🔍 Grok: Upscale not in this menu, trying next...');
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await waitUnthrottled(200);
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
  await waitUnthrottled(300);

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
      await waitUnthrottled(200);
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
      await waitUnthrottled(200);
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
  if (PROVIDER !== 'grok') return true;

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
    await waitUnthrottled(200);
  }

  if (!upscaleStarted) {
    console.log('⚠️ Grok: Upscaling indicator not detected (may already be processing)');
    // Still wait some time in case upscaling is happening without visible indicator
    await waitUnthrottled(5000);
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
        await waitUnthrottled(3000);
        return true;
      }
    } else {
      stableCount = 0;
    }

    await waitUnthrottled(500);
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
    console.log(`🔍 Watching for UI elements (${PROVIDER})...`);

    function logUiDiagnostics() {
      const mainTextareas = document.querySelectorAll('textarea').length;
      const mainRoleTextboxes = document.querySelectorAll('[role="textbox"]').length;
      const mainContentEditable = document.querySelectorAll('[contenteditable="true"]').length;
      const submitButtons = document.querySelectorAll('button[type="submit"]').length;

      console.log(`🧩 UI diagnostics (${PROVIDER}):`, {
        mainTextareas,
        mainRoleTextboxes,
        mainContentEditable,
        submitButtons
      });
    }

    // Function to check if UI is ready
    function checkIfReady() {
      // Find prompt input (textarea OR contenteditable OR role=textbox etc) using shadow-DOM aware lookup
      const promptEl = findElement(SELECTORS.promptInput);
      const hasPromptInput = !!promptEl;

      const isConv = isFlowConversationPage();

      // For Flow: only require the textarea. The arrow/generate button is searched
      // dynamically inside submitFlowPrompt() using proximity-based heuristics.
      if (PROVIDER === 'flow') {
        if (hasPromptInput) {
          console.log(`✅ UI detected and ready! (${PROVIDER}) - textarea found`);
        }
        return hasPromptInput;
      }

      // Find action button (main DOM or shadow DOM) OR locate submit near the prompt
      const actionEl = findElement(SELECTORS.actionButton) || findActionButtonNearPrompt(promptEl, ACTION_KEYWORDS);
      const hasActionButton = !!actionEl;

      // Other providers need both input and action button.
      const isReady = hasPromptInput && (hasActionButton || isConv);

      if (isReady) {
        console.log(`✅ UI detected and ready! (${PROVIDER})`);
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
    const timeoutMs = PROVIDER === 'flow' ? 30000 : 15000;
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
        console.log(`⚠️ UI not detected after ${Math.round(timeoutMs / 1000)}s (${PROVIDER})`);
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
  console.log('=== DOM DEBUG ===');
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

// Note: we intentionally do NOT scan the entire Whisk UI on page load.
// The page is heavy and changes frequently; aggressive polling can slow down
// Whisk boot. We only run UI detection when the user starts generation.

// Listen for messages from background
// Guard against duplicate listeners when ensureTabContentScript re-injects this file.
if (!window.__BULKYGEN_CS_LISTENER__) {
window.__BULKYGEN_CS_LISTENER__ = true;
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'togglePanel') {
    togglePanel();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'generateImage') {
    const __genItemId = message.itemId;
    const __pushResult = (result) => {
      // Push the result back independently of the response channel. Long
      // generations can outlive the sendMessage channel (MV3), so this push is
      // the reliable delivery path; the background waits for it if the channel
      // closes, instead of wasting a regeneration.
      try {
        (globalThis.chrome || ext).runtime.sendMessage({
          action: 'generationResult', itemId: __genItemId, result
        });
      } catch (e) { /* ignore */ }
    };
    generateImage(message.prompt, __genItemId)
      .then(result => {
        // For Grok: Include flag to tell background script to navigate and wait
        if (result.success && PROVIDER === 'grok') {
          result.needsNavigation = true;
          result.navigateTo = 'https://grok.com/imagine/';
        }
        __pushResult(result);
        try { sendResponse(result); } catch (e) { /* channel may be closed */ }
      })
      .catch(error => {
        __pushResult({ success: false, error: error.message });
        try { sendResponse({ success: false, error: error.message }); } catch (e) { /* ignore */ }
      });
    return true; // Keep channel open for async response
  }

  if (message.action === 'flowSubmitPrompt') {
    clientLog('info', 'Flow', `Received flowSubmitPrompt message (itemId=${message.itemId}).`);
    const __flowItemId = message.itemId;
    const __pushFlowResult = (result) => {
      // Same reliable delivery path used for generateImage: push the result
      // independently of the sendMessage response channel. Flow generations
      // (waitForFlowResults can run up to 120s, plus injection/click time) can
      // easily outlive that channel in MV3 — without this push, a result that
      // arrives after the channel closed was silently lost, so the background
      // loop assumed failure and resubmitted the SAME prompt into Flow again,
      // which is why generation appeared to loop forever and always hit the
      // 300s pipeline timeout.
      try {
        (globalThis.chrome || ext).runtime.sendMessage({
          action: 'generationResult', itemId: __flowItemId, result
        });
      } catch (e) { /* ignore */ }
    };
    submitFlowPrompt(message.prompt, message.itemId)
      .then(result => {
        __pushFlowResult(result);
        try { sendResponse(result); } catch (e) { /* channel may be closed */ }
      })
      .catch(error => {
        const result = { success: false, error: error.message };
        __pushFlowResult(result);
        try { sendResponse(result); } catch (e) { /* ignore */ }
      });
    return true;
  }

  if (message.action === 'bgKeepAlive') {
    // Background asks us to hold the silent-audio keep-alive for the WHOLE run
    // (not just per prompt), so the tab never re-throttles between steps.
    if (message.on) {
      if (!__bgPersistKeepAlive) {
        __bgPersistKeepAlive = true;
        __capturedResultKeys.clear();
        __capturedResultSrcs.clear();
        __capturedDataUrls.clear();
        ensureKeepAlive();
      }
    } else if (__bgPersistKeepAlive) {
      __bgPersistKeepAlive = false; releaseKeepAlive();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'checkPage') {
    sendResponse({ provider: PROVIDER, isSupportedPage: PROVIDER !== 'unknown' });
    return false;
  }
  return false;
});
} // end __BULKYGEN_CS_LISTENER__ guard

function collectResultElements() {
  const results = [];
  const seen = new Set();

  function push(el) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    results.push(el);
  }

  function scan(root) {
    try {
      // Collect img, canvas, and video elements for all providers
      // (Grok and Meta AI both generate videos)
      root.querySelectorAll('img,canvas,video').forEach(push);
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) scan(el.shadowRoot);
      });
    } catch {
      // ignore
    }
  }

  scan(document);
  return results;
}

function elementKey(el) {
  if (!el) return '';
  if (el.tagName === 'IMG') {
    const src = el.currentSrc || el.src || '';
    // For blob/data URLs, include dimensions to detect when a new image is loaded
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      const w = el.naturalWidth || el.width || 0;
      const h = el.naturalHeight || el.height || 0;
      return `img:${src}:${w}x${h}`;
    }
    return `img:${src}`;
  }
  if (el.tagName === 'CANVAS') {
    const w = el.width || 0;
    const h = el.height || 0;
    return `canvas:${w}x${h}`;
  }
  if (el.tagName === 'VIDEO') {
    const src = el.currentSrc || el.src || '';
    const w = el.videoWidth || el.width || 0;
    const h = el.videoHeight || el.height || 0;
    return `video:${src}:${w}x${h}`;
  }
  return '';
}

function pickBestImageElement(elements, excludeKeys) {
  const candidates = [];
  for (const el of elements) {
    const key = elementKey(el);
    if (!key) continue;
    if (excludeKeys && excludeKeys.has(key)) continue;

    let score = 0;
    if (el.tagName === 'IMG') {
      const src = el.currentSrc || el.src || '';

      // Skip tiny icons, avatars, and UI images
      const w = el.naturalWidth || el.width || 0;
      const h = el.naturalHeight || el.height || 0;
      // Only consider images that are reasonably large (likely generated content)
      if (w < 200 || h < 200) continue;
      // Skip common UI image patterns
      if (src.includes('avatar') || src.includes('icon') || src.includes('logo')) continue;
      // Skip preview/placeholder images (Grok shows preview_image.jpg during generation)
      if (src.includes('preview_image') || src.includes('placeholder') || src.includes('thumbnail')) continue;
      // Skip static marketing/demo assets that live on the same CDN as real
      // results (DIGEN serves /demo/ and /apps/ promo images from cloudfront).
      if (/\/(demo|apps|landing|marketing|samples?|examples?)\//i.test(src)) continue;
      // Prefer blob/data URLs and CDN URLs (generated images)
      score = w * h;
      if (src.startsWith('blob:') || src.startsWith('data:')) score += 100000;
      if (src.includes('googleusercontent') || src.includes('cdn')) score += 50000;
      // Meta AI: boost score for fbcdn/scontent URLs (generated images)
      if (src.includes('fbcdn') || src.includes('scontent') || src.includes('fbsbx')) score += 80000;
      // Grok: boost score for grok.com/assets.grok.com URLs (generated images)
      if (src.includes('grok.com') || src.includes('assets.grok') || src.includes('twimg')) score += 80000;
      // DIGEN AI: boost score for r2.dev/digen/cloudflare URLs (generated images)
      if (PROVIDER === 'digen' && (src.includes('r2.dev') || src.includes('digen') || src.includes('cloudflare') || src.includes('cloudfront'))) score += 100000;
    } else if (el.tagName === 'VIDEO') {
      // Check VIDEO before CANVAS - videos are preferred for Grok
      const src = el.currentSrc || el.src || '';
      const w = el.videoWidth || el.width || 0;
      const h = el.videoHeight || el.height || 0;
      // Only consider videos that are reasonably large
      if (w < 200 || h < 200) continue;
      // Check if video has any data (readyState >= 1 means has metadata)
      if (el.readyState < 1) continue;
      // Skip videos that don't have a valid source
      if (!src || src === 'about:blank') continue;
      // Boost score for videos significantly - prefer over canvas
      score = w * h + 300000;
      // Meta AI: boost score for fbcdn/scontent URLs (generated videos)
      if (src.includes('fbcdn') || src.includes('scontent') || src.includes('fbsbx')) score += 100000;
      // Grok: boost score for grok.com/assets.grok.com URLs (generated videos) or blob URLs
      if (src.includes('grok.com') || src.includes('assets.grok') || src.includes('twimg') || src.startsWith('blob:')) score += 150000;
      // DIGEN AI: boost score for r2.dev/digen/cloudflare URLs (generated videos)
      if (PROVIDER === 'digen' && (src.includes('r2.dev') || src.includes('digen') || src.includes('cloudflare') || src.includes('cloudfront'))) score += 150000;
    } else if (el.tagName === 'CANVAS') {
      const w = el.width || 0;
      const h = el.height || 0;
      if (w < 200 || h < 200) continue;
      score = w * h;
      // For Grok: lower canvas priority since we prefer video elements
      // (canvas often shows black frame while video is playing)
      if (PROVIDER === 'grok') score -= 50000;
    }
    if (score > 0) candidates.push({ el, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.el || null;
}

// For Meta AI: get all 4 results (images or videos)
function getAllMetaAIResults(elements, excludeKeys) {
  const candidates = [];
  for (const el of elements) {
    const key = elementKey(el);
    if (!key) continue;
    if (excludeKeys && excludeKeys.has(key)) continue;

    let score = 0;

    // Look for video elements
    if (el.tagName === 'VIDEO') {
      const src = el.currentSrc || el.src || '';
      const w = el.videoWidth || el.width || 0;
      const h = el.videoHeight || el.height || 0;
      // Only consider videos that are reasonably large
      if (w < 200 || h < 200) continue;
      score = w * h + 200000; // Prefer videos slightly
    }
    // Look for image elements
    else if (el.tagName === 'IMG') {
      const src = el.currentSrc || el.src || '';
      const w = el.naturalWidth || el.width || 0;
      const h = el.naturalHeight || el.height || 0;
      // Only consider images that are reasonably large
      if (w < 200 || h < 200) continue;
      // Skip tiny icons, avatars, and UI images
      if (src.includes('avatar') || src.includes('icon') || src.includes('static_map')) continue;
      score = w * h;
    }

    if (score > 0) {
      candidates.push({ el, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  // Return top 4 results
  return candidates.slice(0, 4).map(c => c.el);
}

async function waitForNewBestResult(previousKeys, timeoutMs = 300000) {
  const start = Date.now();
  let lastLogTime = 0;
  let foundCandidate = null;
  let stableCount = 0;

  // For Meta AI, we need to wait for all 4 results (images or videos)
  const isMetaAI = PROVIDER === 'metaai';
  const isDigen = PROVIDER === 'digen';
  const requiredCount = isMetaAI ? 4 : 1;

  while (Date.now() - start < timeoutMs) {
    const all = collectResultElements();

    // Log progress every 10 seconds
    if (Date.now() - lastLogTime > 10000) {
      console.log(`🔍 Waiting for new ${isMetaAI ? 'results' : 'result'}... (${Math.round((Date.now() - start) / 1000)}s, found ${all.length} elements, generating=${isStillGenerating()})`);
      lastLogTime = Date.now();
    }

    // Check for content moderation (Grok)
    if (PROVIDER === 'grok' && isContentModerated()) {
      console.log('⚠️ Grok: Content moderated, skipping this prompt');
      return { moderated: true };
    }

    if (isMetaAI) {
      // For Meta AI: wait for all 4 results
      const results = getAllMetaAIResults(all, previousKeys);

      if (results.length >= requiredCount) {
        // Found candidates - wait for them to stabilize
        const resultKeys = results.map(v => elementKey(v)).join('|');
        if (foundCandidate === resultKeys) {
          stableCount++;
          // keys have been stable for 2.5 seconds (5 checks), consider them ready
          if (stableCount >= 5) {
            console.log(`✅ Found ${results.length} stable new results for Meta AI`);
            return results; // Return array of results
          }
        } else {
          foundCandidate = resultKeys;
          stableCount = 1;
          console.log(`🔄 Found ${results.length} candidates, waiting for them to stabilize...`);
        }
      } else {
        foundCandidate = null;
        stableCount = 0;
      }
    } else {
      // For other providers: single image/video
      const best = pickBestImageElement(all, previousKeys);

      // Check if generation is still in progress
      const stillGenerating = isStillGenerating();

      // For Grok: we need to wait for generation to complete (button text changes from "Generating...")
      // The key change: for Grok, we wait for stillGenerating to become FALSE before accepting results
      const isGrok = PROVIDER === 'grok';

      if (stillGenerating) {
        // Generation is in progress - reset and wait
        if (Date.now() - lastLogTime > 5000) {
          console.log('🔄 Still generating... waiting for completion');
          lastLogTime = Date.now();
        }
        foundCandidate = null;
        stableCount = 0;
      } else if (best) {
        // Found a candidate and generation appears complete - wait for it to stabilize
        // For DIGEN AI: much faster stabilization - only 2 checks (1 second total)
        // For Grok: reduced stabilization time - we capture immediately after generation (no upscale wait)
        const requiredStable = isDigen ? 2 : (isGrok ? 3 : 3);
        const bestKey = elementKey(best);
        if (foundCandidate === bestKey) {
          stableCount++;
          // Image/video has been stable for required checks, consider it ready
          if (stableCount >= requiredStable) {
            console.log('✅ Found stable new result:', best.tagName, best.naturalWidth || best.videoWidth || best.width, 'x', best.naturalHeight || best.videoHeight || best.height);

            if (isGrok) {
              console.log('🎬 Grok: Result found, starting upscale process...');

              // RETRY LOOP FOR UPSCALE BUTTON
              // Sometimes the button takes a moment to appear after generation "completes"
              let upscaleClicked = false;
              for (let attempt = 0; attempt < 10; attempt++) {
                console.log(`🎬 Grok Upscale Attempt ${attempt + 1}/10...`);
                upscaleClicked = await clickGrokUpscaleButton();
                if (upscaleClicked) break;

                // If not found, check if we are still generating (false positive completion?)
                if (isStillGenerating()) {
                  console.log('🔄 Grok: Generation indicator reappeared, waiting...');
                  foundCandidate = null; // Reset candidate
                  break; // Break upscale loop to go back to main wait loop
                }

                await waitUnthrottled(1000);
              }

              if (upscaleClicked) {
                console.log('⏳ Grok: Waiting for upscale to complete...');
                const upscaleSuccess = await waitForGrokUpscaleComplete();
                if (upscaleSuccess) {
                  console.log('✅ Grok: Upscale completed successfully');
                  await waitUnthrottled(2000);
                  const refreshedMsg = '🔄 Grok: Re-checking video element after upscale...';
                  console.log(refreshedMsg);
                } else {
                  console.log('⚠️ Grok: Upscale wait timed out or failed, proceeding with current result');
                }
              } else if (foundCandidate === null) {
                // We reset because generation reappeared
                console.log('🔄 Grok: Resuming generation wait...');
                continue;
              } else {
                console.log('⚠️ Grok: Upscale button NOT found after retries. Proceeding with standard capture.');
                // We proceed, but logs will show we failed to upscale
              }
            }

            return best; // Return single element
          }
        } else {
          foundCandidate = bestKey;
          stableCount = 1;
          console.log('🔄 Found new candidate, waiting for it to stabilize...', isGrok ? '(Grok: waiting for generation/upscale)' : (isDigen ? '(DIGEN: fast capture)' : ''));
        }
      } else {
        // No new candidate found in snapshot diff
        foundCandidate = null;
        stableCount = 0;

        // DIGEN AI fallback: if no new elements found after 15 seconds, 
        // grab the largest available image/video (DIGEN may update existing elements)
        if (isDigen && (Date.now() - start) > 15000) {
          console.log('🔍 DIGEN: No new elements found, trying fallback to largest image...');
          // Get the single largest image ignoring the snapshot
          const allCandidates = [];
          for (const el of all) {
            let score = 0;
            if (el.tagName === 'IMG') {
              const src = el.currentSrc || el.src || '';
              const w = el.naturalWidth || el.width || 0;
              const h = el.naturalHeight || el.height || 0;
              if (w < 200 || h < 200) continue;
              if (src.includes('avatar') || src.includes('icon') || src.includes('logo')) continue;
              if (/\/(demo|apps|landing|marketing|samples?|examples?)\//i.test(src)) continue;
              score = w * h;
              if (src.includes('r2.dev') || src.includes('digen') || src.includes('cloudflare') || src.includes('cloudfront')) score += 100000;
            } else if (el.tagName === 'VIDEO') {
              const src = el.currentSrc || el.src || '';
              const w = el.videoWidth || el.width || 0;
              const h = el.videoHeight || el.height || 0;
              if (w < 200 || h < 200) continue;
              score = w * h + 300000;
              if (src.includes('r2.dev') || src.includes('digen') || src.includes('cloudflare') || src.includes('cloudfront')) score += 150000;
            }
            if (score > 0) allCandidates.push({ el, score });
          }

          if (allCandidates.length > 0) {
            allCandidates.sort((a, b) => b.score - a.score);
            const bestFallback = allCandidates[0].el;
            console.log('✅ DIGEN fallback: Found largest element:', bestFallback.tagName,
              bestFallback.naturalWidth || bestFallback.videoWidth || bestFallback.width, 'x',
              bestFallback.naturalHeight || bestFallback.videoHeight || bestFallback.height);
            return bestFallback;
          }
        }
      }
    }

    await waitUnthrottled(isDigen ? 80 : 150); // fast polling for all providers
  }

  console.log(`⚠️ Timeout waiting for new ${isMetaAI ? 'videos' : 'image'}`);
  return null;
}

// Helper to prevent background tab throttling using Web Audio API silence
// This forces the browser to keep the tab execution priority high
function preventBackgroundThrottling() {
  try {
    if (!window.AudioContext && !window.webkitAudioContext) return () => { };

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Near-silent, but loud enough that Chrome flags the tab as "audible" --
    // which is what actually exempts the page from background timer throttling.
    // 18 kHz is inaudible to virtually everyone, and the gain is tiny.
    gainNode.gain.value = 0.003;
    oscillator.frequency.value = 18000;

    let started = false;
    let gestureHandler = null;

    const startSilently = () => {
      // Browsers block AudioContext until a user gesture. Resume first, then
      // start the oscillator only once the context is actually running, so we
      // never trigger the "AudioContext was not allowed to start" warning.
      const tryStart = () => {
        if (started || ctx.state !== 'running') return;
        try {
          oscillator.start();
          started = true;
          console.log('🔊 Background keep-alive active (silent audio)');
        } catch (e) { /* already started */ }
      };
      if (ctx.state === 'running') {
        tryStart();
      } else {
        // Resume quietly; ignore the rejection that happens without a gesture
        ctx.resume().then(tryStart).catch(() => { });
        // Retry on the next real user gesture
        gestureHandler = () => { ctx.resume().then(tryStart).catch(() => { }); };
        window.addEventListener('pointerdown', gestureHandler, { once: true, capture: true });
        window.addEventListener('keydown', gestureHandler, { once: true, capture: true });
      }
    };

    startSilently();

    // Re-assert audio whenever the tab is hidden/shown so the browser keeps the
    // page off the background-throttle list while we switch tabs/windows/apps.
    const onVisibility = () => {
      ctx.resume().then(() => {
        if (!started && ctx.state === 'running') {
          try { oscillator.start(); started = true; } catch (e) { }
        }
      }).catch(() => { });
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility, true);
    window.addEventListener('blur', onVisibility, true);

    // Self-heal: if the browser suspends the context (or it never resumed for
    // lack of a gesture), keep retrying so the tab stays audible & unthrottled.
    const healTimer = setInterval(() => {
      if (ctx.state !== 'running') {
        ctx.resume().then(() => {
          if (!started && ctx.state === 'running') {
            try { oscillator.start(); started = true; } catch (e) { }
          }
        }).catch(() => { });
      }
    }, 1500);

    return () => {
      try {
        clearInterval(healTimer);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('focus', onVisibility, true);
        window.removeEventListener('blur', onVisibility, true);
        if (gestureHandler) {
          window.removeEventListener('pointerdown', gestureHandler, { capture: true });
          window.removeEventListener('keydown', gestureHandler, { capture: true });
        }
        if (started) { try { oscillator.stop(); } catch (e) { } }
        ctx.close();
        console.log('🔇 Background keep-alive stopped');
      } catch (e) { }
    };
  } catch (e) {
    console.log('Failed to start background keep-alive:', e);
    return () => { };
  }
}

// Helper to send completion notification
async function notifyCompletion(count, successCount) {
  try {
    const title = 'BulkyGen Complete';
    const message = `Finished processing ${count} items. ${successCount} successful.`;

    // Method 1: Extension notification
    await ext.runtime.sendMessage({
      action: "showNotification",
      title: title,
      message: message
    }).catch(() => { });

    // Method 2: Browser Notification API
    if (typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') {
        new Notification(title, { body: message });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            new Notification(title, { body: message });
          }
        });
      }
    }
  } catch (e) {
    console.log('Notification failed:', e);
  }
}

// Main generation function
function maybeWarnAboutFlowModel() {
  if (PROVIDER !== 'flow') return;
  const required = PROVIDERS.flow?.requiredModelText;
  if (!required) return;

  try {
    const hay = normalizeText(document.body?.innerText || '');
    if (!hay.includes(required)) {
      console.warn('⚠️ Flow: Nano Banana model not detected in page text. If needed, select it in Flow before starting.');
    }
  } catch {
    // ignore
  }
}

// Persistent, ref-counted keep-alive so the silent audio plays continuously
// for the WHOLE run (including the gaps between prompts) instead of being torn
// down and recreated each prompt. A lingering stop keeps it alive across short
// gaps so the tab never drops off the unthrottled list mid-queue.
// Cross-prompt record of results already captured this run, so the SAME image
// is never returned for two different queue slots (fixes duplicate thumbnails
// where every slot showed the first prompt\'s image).
const __capturedResultKeys = new Set();
const __capturedResultSrcs = new Set();
const __capturedDataUrls = new Set();
let __kaStop = null;
let __bgPersistKeepAlive = false;
let __kaRefs = 0;
let __kaLingerTimer = null;
// The itemId of whatever generation is currently in flight in this content
// script context. Set to null when idle. Used by the unload handler below to
// send a failure signal to the background when this context is torn down while
// a generation is still running (e.g. Flow SPA navigates away mid-generation),
// so the pipeline fails fast instead of waiting 300 seconds.
let __activeGenerationItemId = null;
function ensureKeepAlive() {
  __kaRefs++;
  if (__kaLingerTimer) { clearTimeout(__kaLingerTimer); __kaLingerTimer = null; }
  if (!__kaStop) __kaStop = preventBackgroundThrottling();
}
function releaseKeepAlive() {
  __kaRefs = Math.max(0, __kaRefs - 1);
  if (__kaRefs === 0 && __kaStop && !__kaLingerTimer) {
    __kaLingerTimer = setTimeout(() => {
      __kaLingerTimer = null;
      if (__kaRefs === 0 && __kaStop) { try { __kaStop(); } catch (e) { } __kaStop = null; }
    }, 60000);
  }
}

async function generateImage(prompt, itemId) {
  // Start background keep-alive to prevent tab throttle
  ensureKeepAlive();
  __activeGenerationItemId = itemId || null;
  try {
    return await generateImageInternal(prompt, itemId);
  } finally {
    __activeGenerationItemId = null;
    releaseKeepAlive();
  }
}

async function submitFlowPrompt(prompt, itemId) {
  if (PROVIDER !== 'flow') {
    clientLog('error', 'Flow', `submitFlowPrompt called but detected provider is "${PROVIDER}", not "flow" — the page BulkyGen is running on doesn't match a Flow project URL.`);
    throw new Error('Flow submit requested on non-Flow page');
  }

  ensureKeepAlive();
  __activeGenerationItemId = itemId || null;

  try {
    console.log('BulkyGen Flow: submitFlowPrompt called, prompt:', prompt.substring(0, 40) + '...');
    clientLog('info', 'Flow', `submitFlowPrompt called for "${prompt.substring(0, 60)}..."`);

    const uiReady = await waitForProviderUI();
    if (!uiReady) {
      clientLog('warn', 'Flow', 'waitForProviderUI() reported not ready (no prompt textarea detected on the page).');
      throw new Error('Flow UI not ready. Make sure the prompt field is visible on the page.');
    }

    const editor = findFlowComposer();
    if (!editor) {
      clientLog('error', 'Flow', 'Could not find the Flow prompt box (findFlowComposer() found no visible contenteditable/textarea) — nothing was typed. Flow\'s composer markup may have changed.');
      throw new Error('Could not find the Flow prompt box');
    }
    console.log('BulkyGen Flow: Found composer', editor.tagName, editor.className);

    const beforeKeys = new Set(
      collectResultElements().filter(el => el.tagName === 'IMG').map(elementKey)
    );
    for (const k of __capturedResultKeys) beforeKeys.add(k);

    editor.scrollIntoView({ behavior: 'instant', block: 'center' });
    await waitUnthrottled(150);

    // --- Inject the prompt and make sure Flow actually registers it ---
    const injected = await injectFlowPrompt(editor, prompt);
    console.log('BulkyGen Flow: injected (registered=' + injected.registered + '):', (injected.text || '').substring(0, 60));
    if (!injected.text) {
      clientLog('error', 'Flow', 'Failed to inject the prompt into the Flow composer — paste/beforeinput dispatch did not put any text in the editor.');
      throw new Error('Failed to inject the prompt into the Flow composer');
    }
    if (!injected.registered) {
      clientLog('warn', 'Flow', 'Prompt text was inserted but the generate button never registered as ready (findFlowSubmitButton heuristics may not match the current page markup).');
    }
    await waitUnthrottled(250);

    // --- Click the generate (arrow) button once it is enabled ---
    const submitted = await clickFlowGenerate(editor, prompt);
    console.log('BulkyGen Flow: submitted =', submitted);
    if (!submitted) {
      clientLog('warn', 'Flow', 'clickFlowGenerate() did not confirm the generate button was clicked.');
    }

    // --- Wait for ALL generated images and capture them (x2 / x4 -> multiple) ---
    const images = [];
    const meta = { provider: 'flow', itemId: itemId ?? null, type: 'image' };
    try {
      const expected = getFlowExpectedCount();
      console.log('BulkyGen Flow: expecting up to ' + expected + ' image(s)');
      const resultImgs = await waitForFlowResults(beforeKeys, expected, 120000);
      console.log('BulkyGen Flow: detected ' + resultImgs.length + ' new image(s)');
      for (const img of resultImgs) {
        const src = img.currentSrc || img.src || '';
        if (!src) continue;
        try {
          const data = await getImageAsBase64(src, img);
          if (data) {
            if (__capturedDataUrls.has(data)) {
              console.log('BulkyGen Flow: skipping duplicate of an already-captured image');
              continue;
            }
            __capturedResultKeys.add(elementKey(img));
            __capturedResultSrcs.add(src);
            __capturedDataUrls.add(data);
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
    __activeGenerationItemId = null;
    releaseKeepAlive();
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
    await waitUnthrottled(40); // let Slate sync its selection from the DOM
    try { dispatch(); } catch { /* ignore */ }
    // Wait for Slate to update its model + re-render (button enables)
    for (let i = 0; i < 9; i++) {
      await waitUnthrottled(60);
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
    const text = normalizeText(btn.textContent || '');
    const aria = normalizeText(btn.getAttribute('aria-label') || '');
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
    const text = normalizeText(btn.textContent || '');
    const aria = normalizeText(btn.getAttribute('aria-label') || '');
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
  await waitUnthrottled(60);
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
    const res = await ext.runtime.sendMessage({ action: 'flowForceClick' });
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
    await waitUnthrottled(200);
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
  const baseImgCount = collectResultElements().filter(el => el.tagName === 'IMG').length;

  // Submission succeeded if: prompt cleared, OR button became disabled (processing),
  // OR a new image/skeleton tile appeared.
  const submitted = () => {
    const stillThere = !!probe && promptText().includes(probe);
    const cur = findFlowSubmitButton(editor);
    const ariaNow = cur ? cur.getAttribute('aria-disabled') : null;
    const imgNow = collectResultElements().filter(el => el.tagName === 'IMG').length;
    return (hadPrompt && !stillThere) || ariaNow === 'true' || imgNow > baseImgCount;
  };

  // Give Slate/React a moment to fully wire the enabled button
  await waitUnthrottled(80);

  for (let attempt = 0; attempt < 5; attempt++) {
    const target = findFlowSubmitButton(editor) || btn;
    if (target) {
      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      await waitUnthrottled(40);
      // Strongest method: call the button's real React onClick from the main world
      await forceClickViaBackground(target);
      await waitUnthrottled(180);
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
    await waitUnthrottled(250);
    const curBtn = findFlowSubmitButton(editor);
    console.log('BulkyGen Flow: click attempt ' + (attempt + 1) +
      ' -> connected=' + (target ? document.contains(target) : 'n/a') +
      ' aria=' + (curBtn ? curBtn.getAttribute('aria-disabled') : 'n/a') +
      ' promptStillThere=' + (!!probe && promptText().includes(probe)));
    if (submitted()) return true;
    await waitUnthrottled(150);
  }

  // Last resort: keyboard submit inside the editor (plain, Ctrl+Enter, Cmd+Enter)
  editor.focus();
  pressKey(editor, 'Enter');
  await waitUnthrottled(400);
  if (submitted()) return true;
  pressKey(editor, 'Enter', { ctrlKey: true });
  await waitUnthrottled(400);
  if (submitted()) return true;
  pressKey(editor, 'Enter', { metaKey: true });
  await waitUnthrottled(500);
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
    ' text="' + normalizeText(el.textContent || '').substring(0, 30) + '"' +
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

// Wait for a newly generated image to appear in the Flow project, then return it
// Best-effort detection of how many images Flow will produce (the "x2" / "x4"
// chip near the model selector). Defaults to 1 if it cannot be determined.
function getFlowExpectedCount() {
  const clamp = (n) => (Number.isFinite(n) && n >= 1 && n <= 8 ? n : null);
  try {
    // Prefer an explicitly selected / pressed "outputs per prompt" control.
    const controls = document.querySelectorAll(
      'button[aria-pressed="true"], [role="button"][aria-pressed="true"], ' +
      '[aria-checked="true"], [data-selected="true"], [class*="selected" i]'
    );
    for (const el of controls) {
      const txt = (el.textContent || '').trim();
      let m = txt.match(/(?:^|[x\u00d7\s])([1-8])\b/i);
      if (m) { const n = clamp(parseInt(m[1], 10)); if (n) return n; }
      const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      m = aria.match(/([1-8])\s*(?:images?|outputs?|results?)/i);
      if (m) { const n = clamp(parseInt(m[1], 10)); if (n) return n; }
    }
    // Fallback: any "xN" / "\u00d7N" badge, or an "N images/outputs" label.
    const els = document.querySelectorAll('button, span, div, p, [aria-label]');
    for (const el of els) {
      const txt = (el.textContent || '').trim();
      let m = txt.match(/^[x\u00d7]\s*([1-8])$/i);
      if (m) { const n = clamp(parseInt(m[1], 10)); if (n) return n; }
      const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      m = aria.match(/([1-8])\s*(?:images?|outputs?|results?)\b/i);
      if (m) { const n = clamp(parseInt(m[1], 10)); if (n) return n; }
    }
  } catch { /* ignore */ }
  return 1;
}

// Detect whether Google Flow is STILL actively generating any tile in the batch.
// This is what lets us wait for the whole x2/x3/x4 batch to finish instead of
// grabbing the first finished image and racing ahead to the next prompt.
function isFlowGenerating() {
  if (PROVIDER !== 'flow') return false;
  const isVisible = (el) => {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch { return false; }
  };

  // 1) Explicit busy / progress signals.
  const busy = document.querySelector('[aria-busy="true"], [role="progressbar"]');
  if (busy && isVisible(busy)) return true;

  // 2) "Generating" / "Creating" / percentage text in small status elements.
  const textEls = document.querySelectorAll('button, span, div, p');
  for (const el of textEls) {
    const text = (el.textContent || '').trim().toLowerCase();
    if (!text || text.length > 40) continue;
    const isGeneratingText = text.includes('generating') || text.includes('creating');
    const isPercent = /^\d{1,3}\s*%$/.test(text) || /\d{1,3}%\s*(?:complete|done)?/.test(text);
    if ((isGeneratingText || isPercent) && isVisible(el)) {
      console.log('BulkyGen Flow: generation active ->', text.slice(0, 30));
      return true;
    }
  }

  // 3) Loading skeleton / shimmer / spinner tiles in the results area.
  const loaders = document.querySelectorAll(
    '[class*="animate-spin"], [class*="spinner" i], [class*="skeleton" i], [class*="shimmer" i], [class*="loading" i]'
  );
  for (const el of loaders) {
    if (isVisible(el)) {
      console.log('BulkyGen Flow: generation active -> loading tile');
      return true;
    }
  }

  return false;
}

// Wait for and collect ALL newly generated images (Flow x2 / x4 produce several).
// Returns an array of <img> elements that were not present before submitting.
async function waitForFlowResults(beforeKeys, expectedCount = 1, timeoutMs = 120000) {
  const start = Date.now();
  const found = new Map(); // key -> img element
  let lastChangeAt = Date.now();

  // Settle window required AFTER generation looks idle before we trust the batch
  // is complete (guards against a brief gap between tiles finishing).
  const SETTLE_MS = 500;
  // How long to keep waiting for missing tiles once Flow is no longer generating
  // (a tile may have failed). Only used when we have fewer than expected.
  const STRAGGLER_GIVEUP_MS = 20000;

  while (Date.now() - start < timeoutMs) {
    const imgs = collectResultElements().filter(el => el.tagName === 'IMG');
    for (const img of imgs) {
      const src = img.currentSrc || img.src || '';
      if (!src) continue;
      // Only count images that have actually finished decoding.
      if (!img.complete) continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 256 || h < 256) continue;
      const key = elementKey(img);
      if (beforeKeys.has(key)) continue;
      if (__capturedResultSrcs.has(src) || __capturedResultKeys.has(key)) continue;
      if (!found.has(key)) {
        found.set(key, img);
        lastChangeAt = Date.now();
        console.log('BulkyGen Flow: new image ' + found.size + '/' + expectedCount + ' (' + w + 'x' + h + ')');
      } else {
        found.set(key, img); // refresh element reference
      }
    }

    const stableFor = Date.now() - lastChangeAt;
    const generating = isFlowGenerating();

    if (generating) {
      // Flow is still rendering one or more tiles in this batch. DO NOT return
      // yet, otherwise the unfinished tiles leak into the next prompt's capture.
      // Defensive escape hatch: if we already have everything we expected and it
      // has been stable for a long time, a lingering spinner shouldn't trap us.
      if (found.size >= expectedCount && stableFor > STRAGGLER_GIVEUP_MS) {
        console.log('BulkyGen Flow: have full batch; ignoring stale generating indicator');
        break;
      }
      await waitUnthrottled(150);
      continue;
    }

    // Flow is no longer actively generating.
    if (found.size >= expectedCount && stableFor > SETTLE_MS) {
      // Whole batch finished and settled.
      break;
    }
    if (found.size >= 1 && found.size < expectedCount && stableFor > STRAGGLER_GIVEUP_MS) {
      // Generation stopped but fewer images than expected showed up (a tile
      // likely failed). Return what we actually have rather than hang.
      console.log('BulkyGen Flow: generation idle with ' + found.size + '/' + expectedCount + ' image(s); returning partial batch');
      break;
    }
    // found.size === 0 (or still settling) -> keep waiting until timeout.
    await waitUnthrottled(150);
  }

  await waitUnthrottled(150); // let the last image fully decode
  return Array.from(found.values());
}

// Internal generation logic (renamed from generateImage)
async function generateImageInternal(prompt, itemId) {
  console.log('🚀 Starting generation for prompt:', prompt);

  logButtonInventoryOnce();

  maybeWarnAboutFlowModel();

  // First, wait for UI to be ready
  console.log(`Waiting for UI to be ready (${PROVIDER})...`);
  const uiReady = await waitForProviderUI();
  if (!uiReady) {
    throw new Error('UI not ready. Please make sure the prompt input and Start/Generate button are visible on the page.');
  }

  try {
    // Step 1: Find and fill prompt input
    console.log('📝 Looking for prompt input...');
    let promptInput = await waitForElement(SELECTORS.promptInput, 10000).catch(() => {
      // Fallback: try to find any textarea or contenteditable
      console.log('Trying fallback selectors...');
      return document.querySelector('textarea') ||
        document.querySelector('[contenteditable="true"]') ||
        document.querySelector('div[role="textbox"]');
    });

    if (!promptInput) {
      throw new Error('Could not find prompt input field - please make sure you are on the Generate page');
    }

    if (PROVIDER === 'gentube') {
      const gentubePrompt = findGentubePromptInput();
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
    await waitUnthrottled(200);

    // Clear and focus
    promptInput.focus();
    promptInput.click();

    await waitUnthrottled(300);

    // For Gentube: specific typing emulation via execCommand to appease its React textareas
      if (PROVIDER === 'gentube') {
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

        await waitUnthrottled(400);
        console.log('✅ Gentube prompt finalization complete');

      } else if (PROVIDER === 'metaai') {
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

      await waitUnthrottled(200);

      // Focus and use execCommand for React compatibility
      promptInput.focus();

      // Typing helper
      const typeWithDelay = async (text, delay) => {
        for (const char of text) {
          document.execCommand('insertText', false, char);
          await waitUnthrottled(delay);
        }
      };

      // Try 1: Standard typing (20ms delay) - increased from 5ms to avoid dropped chars
      await typeWithDelay(finalPrompt, 20);

      // Verify input fidelity
      await waitUnthrottled(300);
      let currentVal = promptInput.innerText || promptInput.textContent || '';

      // Check if text matches (ignoring whitespace differences)
      if (normalizeText(currentVal) !== normalizeText(finalPrompt)) {
        console.warn('⚠️ Meta AI prompt mismatch detected!', { expected: finalPrompt, actual: currentVal });
        console.log('🔄 Retrying slowly (50ms)...');

        // Clear and retry
        promptInput.innerHTML = '';
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        await waitUnthrottled(300);
        promptInput.focus();

        await typeWithDelay(finalPrompt, 60);

        // Verify again
        await waitUnthrottled(500);
        currentVal = promptInput.innerText || promptInput.textContent || '';
        if (normalizeText(currentVal) !== normalizeText(finalPrompt)) {
          console.error('❌ Still mismatch after retry. Using fallback block insert.');
          // Final fallback: insert whole block (faster but might bypass some React logic)
          promptInput.innerHTML = '';
          await waitUnthrottled(200);
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
      await waitUnthrottled(500);
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
      await waitUnthrottled(10);

      // Step 2: Focus fresh
      promptInput.focus();
      promptInput.click();
      await waitUnthrottled(10);

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

      await waitUnthrottled(10);

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

      await waitUnthrottled(10);

      // Focus and use execCommand for React/ProseMirror compatibility
      promptInput.focus();

      // Use document.execCommand for ProseMirror compatibility
      // First select all existing content
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      await waitUnthrottled(100);

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
          await waitUnthrottled(10);
        }
      }

      // Dispatch events to trigger framework updates
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.dispatchEvent(new Event('change', { bubbles: true }));
      promptInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt }));

      console.log('✅ Contenteditable prompt entered');
    }

    // Verify prompt was set (skip for Meta AI as we already verified above)
    if (PROVIDER !== 'metaai') {
      console.log('✅ Prompt entered:', prompt.substring(0, 50) + '...');

      // Verify the value was set
      await waitUnthrottled(200);
      const currentValue = promptInput.value || promptInput.textContent || '';
      console.log('📊 Prompt input value:', currentValue ? currentValue.substring(0, 50) + '...' : '❌ EMPTY!');

      // If empty, try one more time with a different method
      if (!currentValue || currentValue.length === 0) {
        console.log('⚠️ Prompt is empty, trying alternative method (execCommand)...');

        // Blur and re-focus to fully reset state
        promptInput.blur();
        await waitUnthrottled(100);
        promptInput.focus();
        promptInput.click();
        await waitUnthrottled(100);

        // Select all and delete
        promptInput.select?.();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);

        await waitUnthrottled(10);

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

        await waitUnthrottled(200);

        const retryValue = promptInput.value || promptInput.textContent || '';
        console.log('📊 After retry:', retryValue ? retryValue.substring(0, 50) + '...' : '❌ STILL EMPTY!');

        if (!retryValue || retryValue.length === 0) {
          throw new Error('Failed to set prompt value - textarea may be read-only or React is blocking changes');
        }
      }
    }

    // Step 2: Wait for React to update UI
    console.log('⏳ Waiting for React to process prompt value...');
    await waitUnthrottled(10);

    // Step 3: Wait for UI to be ready to submit
    console.log('⏳ Waiting for UI to be ready to submit...');
    await waitUnthrottled(500); // Increased wait to ensure UI is fully ready

    // Snapshot existing results BEFORE submitting
    const allElements = collectResultElements();
    const prevKeys = new Set(allElements.map(elementKey).filter(Boolean));
    console.log(`📸 Snapshot taken: ${prevKeys.size} existing result elements`);


    const isConv = isFlowConversationPage();
    const providerConfig = PROVIDERS[PROVIDER] || PROVIDERS.flow;
    const submitViaEnter = providerConfig.submitViaEnter || isConv;
    const clickSubmitButton = providerConfig.clickSubmitButton || false;

    // Grok: Find and click the submit button (arrow icon near input)
    // NOTE: Check Grok FIRST before the generic clickSubmitButton path
    if (PROVIDER === 'grok') {
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
        await waitUnthrottled(50);

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
        dispatchEnterToSubmit(promptInput);
        console.log('✅ Grok: Enter key dispatched');
      }

    } else if (PROVIDER === 'metaai') {
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

    } else if (PROVIDER === 'gentube') {
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
        submitBtn = findActionButtonNearPrompt(promptInput, ACTION_KEYWORDS) || findElement(SELECTORS.actionButton);
      }

      if (!submitBtn) {
        console.log('⚠️ Gentube: submit button not found, trying Enter key fallback...');
        promptInput.focus();
        dispatchEnterToSubmit(promptInput);
        await waitUnthrottled(300);
      } else {
        submitBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await waitUnthrottled(100);
        submitBtn.focus();
        submitBtn.click();
        submitBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        submitBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        console.log('✅ Gentube: Submit button clicked');
      }

    } else if (PROVIDER === 'flow' && clickSubmitButton) {
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
        submitBtn = findActionButtonNearPrompt(promptInput, ACTION_KEYWORDS);
      }

      if (!submitBtn) {
        console.log('⚠️ Flow: No submit button found, falling back to Enter key...');
        promptInput.focus();
        dispatchEnterToSubmit(promptInput);
        console.log('✅ Flow: Enter key dispatched (fallback)');
      } else {
        submitBtn.focus();
        submitBtn.click();
        console.log('✅ Flow: Submit button clicked');
      }

    } else if (submitViaEnter) {
      console.log(`🖱️ Submitting via Enter (${PROVIDER})...`);
      promptInput.focus();
      dispatchEnterToSubmit(promptInput);
      console.log('✅ Enter submit dispatched');
    } else {
      console.log('⏳ Waiting for UI to enable Generate button...');
      await waitUnthrottled(1500);

      console.log('🔍 Looking for action button...');
      let generateBtn = await waitForElement(SELECTORS.actionButton, 10000).catch(() => {
        // Fallback: find button with action text by searching everywhere
        console.log('Trying fallback for action button...');

        // For Digen: look for icon buttons near textarea first
        if (PROVIDER === 'digen' && promptInput) {
          console.log('🔍 Digen fallback: searching for buttons near textarea...');
          const digenBtn = findActionButtonNearPrompt(promptInput, ACTION_KEYWORDS);
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
          const hit = ACTION_KEYWORDS.some(kw => kw && (text === kw || ariaLabel.includes(kw)));
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
                const text = normalizeText(btn.textContent);
                const ariaLabel = normalizeText(btn.getAttribute('aria-label'));
                const title = normalizeText(btn.getAttribute('title'));
                const btnType = normalizeText(btn.type || btn.getAttribute('type'));
                const disabled = !!btn.disabled || btn.getAttribute('aria-disabled') === 'true';
                const isUpload = ariaLabel.includes('upload');
                const hit = ACTION_KEYWORDS.some(kw => text === kw || ariaLabel.includes(kw) || title.includes(kw));

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
        return findActionButtonNearPrompt(promptInput, ACTION_KEYWORDS);
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
      await waitUnthrottled(10);

      // Click ONCE (double-clicking often triggers duplicate generations)
      console.log('🖱️ Clicking action button (single click)...');
      generateBtn.focus();
      generateBtn.click();
      console.log('✅ Generate click dispatched');
    }

    // Wait a moment for click to register and UI to update to "Generating..." state
    await waitUnthrottled(1000);

    // Wait for generation to complete

    // For Grok: Wait for generation to START (button should show "Generating...")
    // This ensures the prompt was actually submitted before we start looking for results
    // For Grok AND Whisk: Wait for generation to START (button should show "Generating...")
    // This ensures the prompt was actually submitted before we start looking for results
    if (PROVIDER === 'grok' || PROVIDER === 'whisk') {
      console.log(`⏳ ${PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Waiting for generation to start...`);
      let generationStarted = false;
      const startWaitTime = Date.now();
      // Reduced from 2s to 1s - consistent with background execution needs
      const maxStartWait = 1000;

      while (Date.now() - startWaitTime < maxStartWait) {
        if (isStillGenerating()) {
          console.log(`✅ ${PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Generation started`);
          generationStarted = true;
          break;
        }
        await waitUnthrottled(10);
      }

      if (!generationStarted) {
        console.log(`⚠️ ${PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Generation did not start, prompt may not have been submitted. Retrying submit...`);

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
          if (PROVIDER === 'whisk') {
            const actionBtn = findActionButtonNearPrompt(promptInput, ACTION_KEYWORDS);
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
          console.log(`🔄 ${PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Clicking submit button for retry...`);
          retryBtn.focus();
          retryBtn.click();
        } else {
          // Fallback to Enter key
          console.log(`🔄 ${PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Using Enter key for retry...`);
          promptInput.focus();
          dispatchEnterToSubmit(promptInput);
        }

        // Wait a short time for retry to work
        await waitUnthrottled(500);

        // Check again
        if (!isStillGenerating()) {
          console.log(`⚠️ ${PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Generation still not started after retry, but proceeding to result wait to avoid blocking...`);
          // Don't throw error - proceeding might be safer than effective deadlock
        } else {
          console.log(`✅ ${PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Generation started after retry`);
          generationStarted = true;
        }
      }

      // IMPORTANT: Re-take snapshot AFTER generation starts for Grok
      // This ensures we don't capture stale results from previous sessions
      // IMPORTANT: Re-take snapshot AFTER generation starts
      // This ensures we don't capture stale results from previous sessions
      const postStartElements = collectResultElements();
      const postStartKeys = new Set(postStartElements.map(elementKey).filter(Boolean));
      console.log(`📸 ${PROVIDER === 'grok' ? 'Grok' : 'Whisk'}: Post-start snapshot: ${postStartKeys.size} existing result elements`);
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
    if (PROVIDER === 'firefly') {
      const startWait = Date.now();
      let started = false;
      let newImageAlready = false;
      while (Date.now() - startWait < 10000) {
        if (isStillGenerating()) { started = true; console.log('✅ Firefly: generation started'); break; }
        if (pickBestImageElement(collectResultElements(), prevKeys)) { newImageAlready = true; break; }
        await waitUnthrottled(50);
      }
      if (started && !newImageAlready) {
        const postElems = collectResultElements();
        prevKeys.clear();
        for (const el of postElems) { const k = elementKey(el); if (k) prevKeys.add(k); }
        console.log(`📸 Firefly: post-start snapshot: ${prevKeys.size} existing result elements`);
      } else {
        console.log(`📸 Firefly: keeping pre-click snapshot (started=${started}, newImageAlready=${newImageAlready})`);
      }
    }

    // Wait for the best NEW result (for Meta AI, this will be array of 4 results)
    console.log(`⏳ Waiting for best result ${PROVIDER === 'metaai' ? 'results' : 'image'}...`);
    let best = await waitForNewBestResult(prevKeys, 300000);

    // Check if content was moderated
    if (best && best.moderated) {
      throw new Error('CONTENT_MODERATED: Grok flagged this prompt - skipping to next');
    }

    if (!best) {
      throw new Error(`Timed out waiting for generated ${PROVIDER === 'metaai' ? 'results' : 'images'}`);
    }

    // For Meta AI: handle multiple results (images or videos)
    if (PROVIDER === 'metaai' && Array.isArray(best)) {
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
            provider: PROVIDER,
            width: result.videoWidth || result.width || 0,
            height: result.videoHeight || result.height || 0,
            src,
            videoIndex: i + 1,
            totalVideos: best.length,
            type: 'video'
          };
          itemData = await getVideoAsBase64(src, result);
        } else if (result.tagName === 'IMG') {
          const src = result.currentSrc || result.src;
          meta = {
            provider: PROVIDER,
            width: result.naturalWidth || result.width || 0,
            height: result.naturalHeight || result.height || 0,
            src,
            videoIndex: i + 1, // Reuse index for consistency
            totalVideos: best.length,
            type: 'image'
          };
          itemData = await getImageAsBase64(src, result);
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
        meta = { provider: PROVIDER, width: best.naturalWidth || best.width || 0, height: best.naturalHeight || best.height || 0, src };

        // For Grok images: use authenticated fetch (images come from imagine-public.x.ai)
        if (PROVIDER === 'grok') {
          console.log('📸 Grok image detected, trying authenticated fetch...');
          try {
            imageData = await getGrokImageAsBase64(src, best);
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
          imageData = await getImageAsBase64(src, best);
        }
      } else if (best.tagName === 'CANVAS') {
        meta = { provider: PROVIDER, width: best.width || 0, height: best.height || 0, src: 'canvas' };
        imageData = best.toDataURL('image/png');
      } else if (best.tagName === 'VIDEO') {
        const src = best.currentSrc || best.src;
        meta = { provider: PROVIDER, width: best.videoWidth || best.width || 0, height: best.videoHeight || best.height || 0, src };

        // For Grok videos: capture directly
        if (PROVIDER === 'grok') {
          console.log('📹 Grok video detected, capturing...');
          try {
            imageData = await getGrokVideoAsBase64(src, best);
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
          imageData = await getVideoAsBase64(src, best);
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

// Direct image download
async function downloadImageDirectly(imageUrl, filename) {
  try {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `${PROVIDER}-${sanitizeFilename(filename)}-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('Image downloaded directly');
  } catch (error) {
    console.error('Direct download failed:', error);
  }
}

// Get image as base64
async function getImageAsBase64(imageUrl, imgElement = null) {
  // First try fetch (works for same-origin and blob URLs)
  try {
    const response = await fetch(imageUrl, { mode: 'cors' });
    if (response.ok) {
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
  } catch (error) {
    console.log('Fetch failed, trying background script fallback:', error.message);
  }

  // Second: Use background script to fetch (bypasses CORS in service worker)
  try {
    const result = await ext.runtime.sendMessage({
      action: 'fetchImageAsBase64',
      imageUrl: imageUrl
    });
    if (result && result.success && result.dataUrl) {
      console.log('✅ Image fetched via background script');
      return result.dataUrl;
    }
    if (result && !result.success) {
      console.log('Background fetch failed:', result.error);
    }
  } catch (bgError) {
    console.log('Background script fetch failed:', bgError.message);
  }

  // Fallback: draw to canvas (works for most cross-origin images loaded by the page)
  if (imgElement && imgElement.tagName === 'IMG') {
    try {
      const canvas = document.createElement('canvas');
      const w = imgElement.naturalWidth || imgElement.width || 512;
      const h = imgElement.naturalHeight || imgElement.height || 512;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgElement, 0, 0, w, h);
      return canvas.toDataURL('image/png');
    } catch (canvasError) {
      console.error('Canvas fallback also failed:', canvasError.message);
    }
  }

  throw new Error('Failed to convert image to base64 - image may be cross-origin protected');
}

// Get video as base64 (for Meta AI videos and Grok videos)
async function getVideoAsBase64(videoUrl, videoElement = null) {
  console.log('📹 Fetching video from URL:', videoUrl);

  // For Grok videos: If it's a blob URL and we have a video element, try to capture the video source directly
  if (videoElement && videoElement.tagName === 'VIDEO') {
    // First, make sure video has loaded
    if (videoElement.readyState < 2) {
      console.log('⏳ Waiting for video to load...');
      await new Promise((resolve) => {
        const onLoaded = () => {
          videoElement.removeEventListener('loadeddata', onLoaded);
          resolve();
        };
        videoElement.addEventListener('loadeddata', onLoaded);
        // Timeout after 10 seconds
        setTimeout(resolve, 10000);
      });
    }
  }

  // First try fetch (works for same-origin and blob URLs)
  try {
    const response = await fetch(videoUrl, { mode: 'cors' });
    if (response.ok) {
      const blob = await response.blob();
      console.log('✅ Video fetched successfully, MIME type:', blob.type, 'size:', blob.size);
      // Skip if blob is too small (likely failed or placeholder)
      if (blob.size < 1000) {
        console.log('⚠️ Video blob is too small, might be placeholder');
        throw new Error('Video blob too small');
      }
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          console.log('✅ Video converted to base64');
          resolve(reader.result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
  } catch (error) {
    console.log('Video fetch failed, trying fallbacks:', error.message);
  }

  // Second: Use background script to fetch (bypasses CORS in service worker)
  try {
    const result = await ext.runtime.sendMessage({
      action: 'fetchImageAsBase64', // Reuse the same endpoint for videos
      imageUrl: videoUrl
    });
    if (result && result.success && result.dataUrl) {
      console.log('✅ Video fetched via background script');
      return result.dataUrl;
    }
    if (result && !result.success) {
      console.log('Background fetch failed:', result.error);
    }
  } catch (bgError) {
    console.log('Background script fetch failed:', bgError.message);
  }

  // Third: Try direct blob URL conversion
  if (videoElement && videoElement.src && videoElement.src.startsWith('blob:')) {
    try {
      const response = await fetch(videoElement.src);
      const blob = await response.blob();
      if (blob.size >= 1000) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch (blobError) {
      console.error('Blob URL fetch failed:', blobError.message);
    }
  }

  // Fourth fallback: Capture a frame from the video element as an image
  if (videoElement && videoElement.tagName === 'VIDEO') {
    console.log('📹 Trying to capture video frame as fallback...');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = videoElement.videoWidth || videoElement.width || 1280;
      canvas.height = videoElement.videoHeight || videoElement.height || 720;
      const ctx = canvas.getContext('2d');

      // Seek to first frame if video hasn't started
      if (videoElement.currentTime === 0 && videoElement.duration > 0) {
        videoElement.currentTime = 0.1;
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const frameData = canvas.toDataURL('image/png');

      // Check if frame is valid (not all black/transparent)
      const imageData = ctx.getImageData(0, 0, Math.min(100, canvas.width), Math.min(100, canvas.height));
      let hasContent = false;
      for (let i = 0; i < imageData.data.length; i += 4) {
        if (imageData.data[i] > 10 || imageData.data[i + 1] > 10 || imageData.data[i + 2] > 10) {
          hasContent = true;
          break;
        }
      }

      if (hasContent) {
        console.log('✅ Video frame captured as PNG');
        return frameData;
      } else {
        console.log('⚠️ Captured frame appears to be black');
      }
    } catch (frameError) {
      console.error('Video frame capture failed:', frameError.message);
    }
  }

  throw new Error('Failed to convert video to base64 - video may be cross-origin protected');
}

// Special handler for Grok images (require authentication from imagine-public.x.ai)
async function getGrokImageAsBase64(imageUrl, imgElement = null) {
  console.log('📸 Grok: Fetching image from URL:', imageUrl);

  // Method 1: Try fetch with credentials (content script can access cookies)
  try {
    const response = await fetch(imageUrl, {
      mode: 'cors',
      credentials: 'include'
    });
    if (response.ok) {
      const blob = await response.blob();
      if (blob.size > 1000) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    }
  } catch (fetchError) {
    console.log('Fetch with credentials failed:', fetchError.message);
  }

  // Method 2: Try XMLHttpRequest with credentials
  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', imageUrl, true);
      xhr.responseType = 'blob';
      xhr.withCredentials = true;

      xhr.onload = function () {
        if (xhr.status === 200 || xhr.status === 206) {
          const blob = xhr.response;
          if (blob && blob.size > 1000) {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          } else {
            reject(new Error('Image blob too small'));
          }
        } else {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error('XHR failed'));
      xhr.send();
    });

    console.log('✅ Grok: Image fetched via XHR with credentials');
    return data;
  } catch (xhrError) {
    console.log('XHR with credentials failed:', xhrError.message);
  }

  // Method 3: Try background script fetch
  try {
    const result = await ext.runtime.sendMessage({
      action: 'fetchImageAsBase64',
      imageUrl: imageUrl
    });
    if (result && result.success && result.dataUrl) {
      console.log('✅ Grok: Image fetched via background script');
      return result.dataUrl;
    }
    if (result && !result.success) {
      console.log('Background fetch failed:', result.error);
    }
  } catch (bgError) {
    console.log('Background script fetch failed:', bgError.message);
  }

  // Method 4: Fall back to regular image capture
  return await getImageAsBase64(imageUrl, imgElement);
}

// Special handler for Grok videos (require authentication)
async function getGrokVideoAsBase64(videoUrl, videoElement = null) {
  console.log('📹 Grok: Fetching video from URL:', videoUrl);

  // Method 1: Try background script fetch FIRST (fastest, bypasses CORS reliably)
  try {
    const result = await ext.runtime.sendMessage({
      action: 'fetchImageAsBase64', // Reuse the same endpoint for videos
      imageUrl: videoUrl
    });
    if (result && result.success && result.dataUrl) {
      console.log('✅ Grok: Video fetched via background script');
      return result.dataUrl;
    }
    if (result && !result.success) {
      console.log('Background fetch failed:', result.error);
    }
  } catch (bgError) {
    console.log('Background script fetch failed:', bgError.message);
  }

  // Method 2: Try fetch with credentials (content script can access cookies)
  try {
    const response = await fetch(videoUrl, {
      mode: 'cors',
      credentials: 'include'
    });
    if (response.ok || response.status === 206) {
      const blob = await response.blob();
      if (blob.size > 1000) {
        console.log('✅ Grok: Video fetched via fetch with credentials');
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    }
  } catch (fetchError) {
    console.log('Fetch with credentials failed:', fetchError.message);
  }

  // Method 3: Try XMLHttpRequest with credentials
  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', videoUrl, true);
      xhr.responseType = 'blob';
      xhr.withCredentials = true; // Important: sends cookies

      xhr.onload = function () {
        // Accept 200 (OK) and 206 (Partial Content) as success
        if (xhr.status === 200 || xhr.status === 206) {
          const blob = xhr.response;
          if (blob && blob.size > 1000) {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          } else {
            reject(new Error('Video blob too small'));
          }
        } else {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error('XHR failed'));
      xhr.send();
    });

    console.log('✅ Grok: Video fetched via XHR with credentials');
    return data;
  } catch (xhrError) {
    console.log('XHR with credentials failed:', xhrError.message);
  }

  // Method 3: Try to find a download link/button on the page for this video
  try {
    // Look for download buttons near the video
    const downloadBtns = document.querySelectorAll('a[download], button[aria-label*="download" i], a[href*="download" i]');
    for (const btn of downloadBtns) {
      const href = btn.href || btn.getAttribute('data-url');
      if (href && (href.includes('generated_video') || href.includes('.mp4'))) {
        console.log('Found download link:', href);
        // Try to fetch this URL
        const response = await fetch(href, { credentials: 'include' });
        if (response.ok) {
          const blob = await response.blob();
          if (blob.size > 1000) {
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          }
        }
      }
    }
  } catch (dlError) {
    console.log('Download link method failed:', dlError.message);
  }

  // Method 4: Fall back to regular video capture (captures a frame as image)
  return await getVideoAsBase64(videoUrl, videoElement);
}

// Sanitize filename
function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

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
// maximum coverage, but gate on __activeGenerationItemId so we only signal when
// there is actually something in flight.
function __onPageUnload() {
  const itemId = __activeGenerationItemId;
  if (!itemId) return; // nothing in flight — nothing to do
  clientLog('warn', 'ContentScript', `Page unloading mid-generation (itemId=${itemId}) — sending failure signal so pipeline retries immediately.`);
  try {
    (globalThis.chrome || ext).runtime.sendMessage({
      action: 'generationResult',
      itemId,
      result: { success: false, error: 'Content script context was destroyed mid-generation (page navigation or reload)' }
    });
  } catch (e) { /* context already gone — background will detect via heartbeat */ }
}
window.addEventListener('pagehide', __onPageUnload, { capture: true });
window.addEventListener('beforeunload', __onPageUnload, { capture: true });