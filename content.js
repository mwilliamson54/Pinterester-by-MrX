// Marker so the side panel / background never double-inject this script.
window.__BULKYGEN_CS_LOADED__ = true;

// Everything below lives inside this IIFE so that re-injecting the content
// script set (manifest's declarative injection AND background's manual
// chrome.scripting.executeScript injection both target the same file list)
// can never throw "Identifier 'x' has already been declared".
//
// The content script is split into several files (see manifest.json /
// ensureTabContentScript's `files:` array) that all share one logical
// module via a namespace object, window.__BulkyGenCS. Each file:
//   1. Bails out immediately if this injection batch shouldn't run its setup
//      (see __BULKYGEN_CS_SHOULD_INIT__ below — computed once, here, per batch).
//   2. Wraps its own code in a private function scope (so re-injecting the
//      whole file set never throws a redeclaration SyntaxError).
//   3. Publishes whatever other files need onto window.__BulkyGenCS, and
//      reads whatever it needs from the same object (as NS.xxx) rather than
//      a one-time destructure, so declaration order across files never
//      matters for values read inside callbacks (the only place cross-file
//      names are actually used).
(function () {
  var shouldInit = !window.__BULKYGEN_CS_FULLY_INIT__;
  window.__BULKYGEN_CS_SHOULD_INIT__ = shouldInit;
  if (!shouldInit) return;
  window.__BULKYGEN_CS_FULLY_INIT__ = true;

  window.__BulkyGenCS = window.__BulkyGenCS || {};
  var NS = window.__BulkyGenCS;



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
    if (host === 'flow.google.com' && path.startsWith('/project/')) return 'flow';
    if ((host === 'meta.ai' || host === 'www.meta.ai') && path.includes('/media')) return 'metaai';
    if (host === 'grok.com' && path.startsWith('/imagine')) return 'grok';
    if (host === 'digen.ai') return 'digen';
    if ((host === 'gentube.app' || host === 'www.gentube.app') && path.startsWith('/create')) return 'gentube';
    if (host === 'firefly.adobe.com' && path.startsWith('/generate')) return 'firefly';
    return 'unknown';
  } catch {
    const href = window.location.href || '';
    if (href.startsWith('https://labs.google/fx/tools/flow/project/')) return 'flow';
    if (href.startsWith('https://flow.google.com/project/')) return 'flow';
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
  // ── Exports for other content-script module files ──
  NS.ext = ext;
  NS.PROVIDER = PROVIDER;
  NS.clientLog = clientLog;
  NS.togglePanel = togglePanel;
  NS.isFlowConversationPage = isFlowConversationPage;
  NS.dispatchEnterToSubmit = dispatchEnterToSubmit;
  NS.DEBUG = DEBUG;
  NS.PROVIDERS = PROVIDERS;
  NS.SELECTORS = SELECTORS;
  NS.ACTION_KEYWORDS = ACTION_KEYWORDS;
  NS.findGentubePromptInput = findGentubePromptInput;
  NS.logButtonInventoryOnce = logButtonInventoryOnce;
  NS.normalizeText = normalizeText;
  NS.findActionButtonNearPrompt = findActionButtonNearPrompt;
  NS.findElement = findElement;
  NS.waitUnthrottled = waitUnthrottled;
  NS.waitForElement = waitForElement;
  NS.isContentModerated = isContentModerated;
})();
