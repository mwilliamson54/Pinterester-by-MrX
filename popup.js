/**
 * BulkyGen Popup — Unified Dashboard + Manual Mode
 *
 * This file merges all original manual-queue functionality (preserved intact)
 * with the new autonomous-mode dashboard (status, stats, pipeline controls).
 *
 * Mode is determined by the `autonomousMode` flag in settings:
 *   - autonomous=true  → shows pipeline status bar, stats grid, start/stop auto
 *   - autonomous=false → shows manual prompt textarea, queue list, and start/stop manual
 *
 * Both modes share: header, stats grid (populated from bulkygenStatistics),
 * last-image panel, error log, footer, and modals.
 */

// ═══════════════════════════════════════════════════════════════════════════
// DOM REFS (safe — returns null for IDs that don't exist in current layout)
// ═══════════════════════════════════════════════════════════════════════════
const promptInput = document.getElementById('promptInput');
const delayInput = document.getElementById('delayInput');
const startBtn = document.getElementById('startBtn');
const resumeBtn = document.getElementById('resumeBtn');
const stopBtn = document.getElementById('stopBtn');
const pauseBtn = document.getElementById('pauseBtn');
const clearBtn = document.getElementById('clearBtn');
const closeBtn = document.getElementById('closeBtn');
const settingsBtn = document.getElementById('settingsBtn');
const generatorSelect = document.getElementById('generatorSelect');
const goToGeneratorBtn = document.getElementById('goToGeneratorBtn');
const downloadZipBtn = document.getElementById('downloadZipBtn');
const donateBtn = document.getElementById('donateBtn');
const buyCodeBtn = document.getElementById('buyCodeBtn');
const queueList = document.getElementById('queueList');
const imageModal = document.getElementById('imageModal');
const donateModal = document.getElementById('donateModal');
const modalImage = document.getElementById('modalImage');
const modalThumbs = document.getElementById('modalThumbs');

// Dashboard-specific refs
const statusBar = document.getElementById('statusBar');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const modeLabel = document.getElementById('modeLabel');
const currentPromptCard = document.getElementById('currentPromptCard');
const currentPromptText = document.getElementById('currentPromptText');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressEta = document.getElementById('progressEta');

// Stats refs
const statToday = document.getElementById('statToday');
const statLifetime = document.getElementById('statLifetime');
const statFailed = document.getElementById('statFailed');
const statQueue = document.getElementById('statQueue');
const statAvgTime = document.getElementById('statAvgTime');
const statETA = document.getElementById('statETA');

// Last image refs
const lastImageSection = document.getElementById('lastImageSection');
const lastThumb = document.getElementById('lastThumb');
const lastPrompt = document.getElementById('lastPrompt');
const lastTime = document.getElementById('lastTime');
const lastDriveLink = document.getElementById('lastDriveLink');

// Autonomous controls
const autonomousControls = document.getElementById('autonomousControls');
const manualControls = document.getElementById('manualControls');
const startAutoBtn = document.getElementById('startAutoBtn');
const stopAutoBtn = document.getElementById('stopAutoBtn');

// Error log
const errorSection = document.getElementById('errorSection');
const errorList = document.getElementById('errorList');

// Footer buttons
const resetSeqBtn = document.getElementById('resetSeqBtn');
const clearImagesBtn = document.getElementById('clearImagesBtn');


// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════
const FLOW_PROJECT_URL_PREFIX = 'https://labs.google/fx/tools/flow/project/';
const DEFAULT_FLOW_PROJECT_ID = 'b4648891-fbc6-46dc-9b49-fed264641aa7';
const METAAI_MEDIA_URL = 'https://www.meta.ai/media';
const GROK_URL = 'https://grok.com/imagine';
const DIGEN_IMAGE_URL = 'https://digen.ai/image';
const GENTUBE_CREATE_URL = 'https://www.gentube.app/create';
const FIREFLY_CREATE_URL = 'https://firefly.adobe.com/generate/image';


// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════

function isFlowUrl(url) { return !!url && url.includes('/fx/tools/flow/project/'); }
function isMetaAIUrl(url) { return !!url && url.includes('meta.ai') && url.includes('/media'); }
function isGrokUrl(url) { return !!url && url.includes('grok.com') && url.includes('/imagine'); }
function isDigenUrl(url) { return !!url && url.includes('digen.ai'); }
function isGentubeUrl(url) { return !!url && url.includes('gentube.app') && url.includes('/create'); }
function isFireflyUrl(url) { return !!url && url.includes('firefly.adobe.com') && url.includes('/generate'); }
function isSupportedUrl(url) {
  return isFlowUrl(url) || isMetaAIUrl(url) || isGrokUrl(url) || isDigenUrl(url) || isGentubeUrl(url) || isFireflyUrl(url);
}

function extractFlowProjectId(url) {
  if (!url) return null;
  const match = url.match(/\/fx\/tools\/flow\/project\/([a-f0-9-]+)/i);
  return match?.[1] || null;
}

async function getMappedFlowProjectUrl() {
  const data = await ext.storage.local.get(['flowProjectId']);
  const projectId = data.flowProjectId || DEFAULT_FLOW_PROJECT_ID;
  return `${FLOW_PROJECT_URL_PREFIX}${projectId}`;
}

async function syncFlowProjectIdFromActiveTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  const projectId = extractFlowProjectId(tab?.url || '');
  if (projectId) await ext.storage.local.set({ flowProjectId: projectId });
}

async function getActiveTabId() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function ensureContentScript(tabId) {
  const scripting = (globalThis.chrome && globalThis.chrome.scripting) ||
    (globalThis.browser && globalThis.browser.scripting);
  if (!scripting || tabId == null) return false;
  try {
    const tab = ext.tabs.get ? await ext.tabs.get(tabId) : null;
    if (tab && !isSupportedUrl(tab.url || '')) return false;
  } catch (_) { }
  try {
    try {
      const probe = await scripting.executeScript({
        target: { tabId },
        func: () => !!window.__BULKYGEN_CS_LOADED__
      });
      if (probe && probe[0] && probe[0].result) return true;
    } catch (_) { }
    await scripting.executeScript({ target: { tabId }, files: ['ext.js', 'content.js'] });
    return true;
  } catch (e) {
    console.debug('ensureContentScript skipped:', (e && e.message) || e);
    return false;
  }
}

async function checkPageWithRetry(tabId) {
  let res = null;
  try { res = await ext.tabs.sendMessage(tabId, { action: 'checkPage' }); } catch { res = null; }
  if (!res) {
    await ensureContentScript(tabId);
    await new Promise(r => setTimeout(r, 250));
    try { res = await ext.tabs.sendMessage(tabId, { action: 'checkPage' }); } catch { res = null; }
  }
  return res;
}

async function warmUpActiveTab() {
  try {
    const tabId = await getActiveTabId();
    if (!tabId) return;
    let ok = false;
    try { const r = await ext.tabs.sendMessage(tabId, { action: 'checkPage' }); ok = !!r; } catch { ok = false; }
    if (!ok) await ensureContentScript(tabId);
  } catch { }
}

async function assertSupportedPageOrThrow() {
  const tabId = await getActiveTabId();
  if (!tabId) throw new Error('No active tab');
  const res = await checkPageWithRetry(tabId);
  if (!res || !res.isSupportedPage) throw new Error('Unsupported page');
  return { tabId, provider: res.provider };
}

async function navigateTo(url) {
  const tabId = await getActiveTabId();
  if (!tabId) { await ext.tabs.create({ url }); return; }
  try { await ext.tabs.update(tabId, { url }); } catch { await ext.tabs.create({ url }); }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════
let editingItemId = null;
let imagesByItemId = new Map();
let modalItemId = null;
let _autonomousMode = false;
let _statsInterval = null;


// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Load settings to determine mode
  await bulkygenSettings.load();
  const settings = await bulkygenSettings.get();
  _autonomousMode = !!settings.autonomousMode;

  applyMode(_autonomousMode);
  await loadState();
  updateUI();
  refreshDashboardStats();
  warmUpActiveTab();

  // In autonomous mode: fetch live Supabase pending count immediately on open
  if (_autonomousMode && typeof bulkygenSupabase !== 'undefined') {
    try {
      const liveCount = await bulkygenSupabase.fetchPendingCount(settings);
      if (statQueue) statQueue.textContent = liveCount;
    } catch { /* non-fatal */ }
  }

  // Periodic stats refresh
  _statsInterval = setInterval(refreshDashboardStats, 3000);

  // Track active tab changes
  const tabsApi = (globalThis.chrome && globalThis.chrome.tabs) ||
    (globalThis.browser && globalThis.browser.tabs);
  if (tabsApi) {
    let warmTimer = null;
    const scheduleWarm = () => { clearTimeout(warmTimer); warmTimer = setTimeout(() => warmUpActiveTab(), 250); };
    try { tabsApi.onActivated && tabsApi.onActivated.addListener(scheduleWarm); } catch { }
    try {
      tabsApi.onUpdated && tabsApi.onUpdated.addListener((id, info) => {
        if (info && (info.status === 'complete' || info.url)) scheduleWarm();
      });
    } catch { }
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// MODE SWITCHING
// ═══════════════════════════════════════════════════════════════════════════

function applyMode(isAuto) {
  _autonomousMode = isAuto;

  // Mode badge
  if (modeLabel) {
    modeLabel.textContent = isAuto ? 'Auto' : 'Manual';
    modeLabel.classList.toggle('auto', isAuto);
  }

  // Show/hide controls
  if (autonomousControls) autonomousControls.style.display = isAuto ? '' : 'none';
  if (manualControls) manualControls.style.display = isAuto ? 'none' : '';
}


// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD STATS (autonomous + manual)
// ═══════════════════════════════════════════════════════════════════════════

async function refreshDashboardStats() {
  try {
    const stats = await bulkygenStatistics.get();
    if (!stats) return;

    // Stats grid
    if (statToday) statToday.textContent = stats.processedToday || 0;
    if (statLifetime) statLifetime.textContent = stats.processedLifetime || 0;
    if (statFailed) statFailed.textContent = (stats.failedToday || 0);
    if (statQueue) statQueue.textContent = stats.currentQueue || 0;

    // Avg time
    const avgMs = stats.processingCount > 0
      ? Math.round(stats.totalProcessingTimeMs / stats.processingCount) : 0;
    if (statAvgTime) statAvgTime.textContent = avgMs > 0 ? formatDuration(avgMs) : '—';

    // ETA
    const etaMs = stats.currentQueue > 0 ? stats.currentQueue * (avgMs || 30000) : 0;
    if (statETA) statETA.textContent = etaMs > 0 ? formatDuration(etaMs) : '—';

    // Status bar
    const status = stats.currentStatus || 'idle';
    if (statusBar) statusBar.className = 'status-bar ' + status;
    if (statusText) statusText.textContent = capitalizeFirst(status);

    // Current prompt
    if (currentPromptText) {
      const p = stats.currentPrompt || '—';
      currentPromptText.textContent = p;
      currentPromptText.classList.toggle('active', p !== '—');
    }

    // Last completed image
    if (stats.lastImageMeta && lastImageSection) {
      lastImageSection.style.display = '';
      if (lastThumb) lastThumb.src = stats.lastImageMeta.thumbnail || '';
      if (lastPrompt) lastPrompt.textContent = stats.lastImageMeta.prompt || '';
      if (lastTime && stats.lastCompletedAt) {
        lastTime.textContent = timeAgo(new Date(stats.lastCompletedAt));
      }
      if (lastDriveLink && stats.lastImageMeta.driveUrl) {
        lastDriveLink.href = stats.lastImageMeta.driveUrl;
        lastDriveLink.style.display = '';
      }
    }

    // Last error
    if (stats.lastError) {
      if (errorSection) errorSection.style.display = '';
      if (errorList) errorList.innerHTML = `<div class="error-entry">${escapeHtml(stats.lastError)}</div>`;
    }

    // Error log from logger
    try {
      const errors = bulkygenLogger.getErrors().slice(-5);
      if (errors.length > 0 && errorSection) {
        errorSection.style.display = '';
        if (errorList) {
          errorList.innerHTML = errors.map(e =>
            `<div class="error-entry"><span class="error-ts">${e.ts?.split('T')[1]?.split('.')[0] || ''}</span> ${escapeHtml(e.msg)}</div>`
          ).join('');
        }
      }
    } catch { }

  } catch (e) {
    console.debug('Stats refresh error:', e);
  }
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return min + 'm ' + rem + 's';
  const hr = Math.floor(min / 60);
  return hr + 'h ' + (min % 60) + 'm';
}

function capitalizeFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function timeAgo(date) {
  const sec = Math.round((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}


// ═══════════════════════════════════════════════════════════════════════════
// MANUAL MODE — State management (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════

async function loadState() {
  const data = await ext.storage.local.get(['prompts', 'delay', 'queue', 'isRunning', 'isPaused', 'generatedImages']);
  if (promptInput) promptInput.value = data.prompts || '';
  if (data.delay && delayInput) delayInput.value = data.delay;
  if (data.generatedImages) await rebuildImagesIndex(data.generatedImages);
  if (data.queue && data.queue.length > 0) {
    renderQueue(data.queue);
    if (downloadZipBtn) downloadZipBtn.disabled = !data.queue.some(i => i.status === 'completed');
  }
  if (data.isRunning) setRunningState(true, !!data.isPaused);
}

function saveState() {
  ext.storage.local.set({
    prompts: promptInput?.value || '',
    delay: delayInput?.value || '3'
  });
}

if (promptInput) promptInput.addEventListener('input', saveState);
if (delayInput) delayInput.addEventListener('change', saveState);


// ═══════════════════════════════════════════════════════════════════════════
// IMAGE INDEX (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════

async function rebuildImagesIndex(generatedImages) {
  imagesByItemId.clear();
  if (!generatedImages || !generatedImages.length) return;
  if (!globalThis.bulkygenImageStore) return;

  for (const rec of generatedImages) {
    if (!rec || !rec.itemId) continue;
    try {
      const full = await globalThis.bulkygenImageStore.getImage(rec.id);
      if (!full || !full.blob) continue;
      const ab = await full.blob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      const chunkSize = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }
      const base64 = btoa(binary);
      const mime = full.mime || rec.mime || 'image/png';
      const dataUrl = `data:${mime};base64,${base64}`;
      const arr = imagesByItemId.get(rec.itemId) || [];
      arr.push({ id: rec.id, data: dataUrl, meta: rec.meta || {} });
      imagesByItemId.set(rec.itemId, arr);
    } catch { }
  }
}

function getImagesForItem(itemId) {
  return imagesByItemId.get(itemId) || imagesByItemId.get(String(itemId)) || [];
}


// ═══════════════════════════════════════════════════════════════════════════
// IMAGE MODAL (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════

function openImageModal(itemId, imgUrl) {
  if (!imageModal) return;
  modalItemId = itemId;
  imageModal.style.display = '';
  imageModal.setAttribute('aria-hidden', 'false');

  const isVideo = imgUrl && imgUrl.startsWith('data:video/');
  let modalVideo = imageModal.querySelector('#modalVideo');

  if (isVideo) {
    if (modalImage) modalImage.style.display = 'none';
    if (!modalVideo) {
      modalVideo = document.createElement('video');
      modalVideo.id = 'modalVideo';
      modalVideo.controls = true; modalVideo.autoplay = true; modalVideo.loop = true;
      modalVideo.style.maxWidth = '100%'; modalVideo.style.maxHeight = '70vh'; modalVideo.style.borderRadius = '8px';
      modalImage?.parentElement?.insertBefore(modalVideo, modalImage);
    }
    modalVideo.src = imgUrl; modalVideo.style.display = '';
  } else {
    if (modalVideo) modalVideo.style.display = 'none';
    if (modalImage) { modalImage.style.display = ''; modalImage.src = imgUrl; }
  }

  // Thumbnails
  const imgs = getImagesForItem(itemId);
  if (modalThumbs) {
    modalThumbs.innerHTML = imgs.map(im => {
      const url = im.data;
      const isVid = url && (url.startsWith('data:video/') || im.meta?.src?.includes('.mp4'));
      if (isVid) return `<video class="modal-thumb" src="${url}" data-url="${url}" muted preload="metadata"></video>`;
      return `<img class="modal-thumb" src="${url}" data-url="${url}" alt="thumb" />`;
    }).join('');
  }
}

function closeImageModal() {
  if (!imageModal) return;
  modalItemId = null;
  imageModal.style.display = 'none';
  imageModal.setAttribute('aria-hidden', 'true');
  if (modalImage) modalImage.src = '';
  const modalVideo = imageModal.querySelector('#modalVideo');
  if (modalVideo) { modalVideo.src = ''; modalVideo.style.display = 'none'; }
}


// ═══════════════════════════════════════════════════════════════════════════
// MANUAL MODE — Start / Stop / Pause / Clear (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════

if (startBtn) {
  startBtn.addEventListener('click', async () => {
    try {
      await assertSupportedPageOrThrow();
    } catch {
      alert('Please navigate to a supported generator page first (Flow, Meta AI, Grok, DIGEN, Gentube, or Firefly).');
      return;
    }

    const promptText = promptInput?.value?.trim() || '';
    if (!promptText) { alert('Please enter at least one prompt'); return; }

    const prompts = promptText.split('\n').map(p => p.trim()).filter(Boolean);
    if (prompts.length === 0) { alert('No valid prompts'); return; }

    const delay = parseInt(delayInput?.value || '3', 10) * 1000;
    const queue = prompts.map((prompt, index) => ({
      id: Date.now() + index,
      prompt,
      status: 'pending'
    }));

    await ext.storage.local.set({
      queue,
      currentIndex: 0,
      isRunning: true,
      isPaused: false,
      delay,
      prompts: promptInput?.value || ''
    });

    renderQueue(queue);
    setRunningState(true);

    await ext.runtime.sendMessage({ action: 'startGeneration' });
  });
}

if (stopBtn) {
  stopBtn.addEventListener('click', async () => {
    await ext.runtime.sendMessage({ action: 'stopGeneration' });
    setRunningState(false);
  });
}

if (pauseBtn) {
  pauseBtn.addEventListener('click', async () => {
    const data = await ext.storage.local.get(['isPaused']);
    if (data.isPaused) {
      await ext.runtime.sendMessage({ action: 'resumeGeneration' });
      setRunningState(true, false);
    } else {
      await ext.runtime.sendMessage({ action: 'pauseGeneration' });
      setRunningState(true, true);
    }
  });
}

if (clearBtn) {
  clearBtn.addEventListener('click', async () => {
    await ext.runtime.sendMessage({ action: 'stopGeneration' });
    await ext.runtime.sendMessage({ action: 'clearAllImages' }).catch(() => { });
    await ext.storage.local.set({ queue: [], currentIndex: 0, isRunning: false, isPaused: false, generatedImages: [] });
    imagesByItemId.clear();
    renderQueue([]);
    if (downloadZipBtn) downloadZipBtn.disabled = true;
    setRunningState(false);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTONOMOUS MODE — Start / Stop
// ═══════════════════════════════════════════════════════════════════════════

if (startAutoBtn) {
  startAutoBtn.addEventListener('click', async () => {
    await ext.runtime.sendMessage({ action: 'startPipeline' });
    if (startAutoBtn) startAutoBtn.disabled = true;
    if (stopAutoBtn) stopAutoBtn.disabled = false;
  });
}

if (stopAutoBtn) {
  stopAutoBtn.addEventListener('click', async () => {
    await ext.runtime.sendMessage({ action: 'stopPipeline' });
    if (startAutoBtn) startAutoBtn.disabled = false;
    if (stopAutoBtn) stopAutoBtn.disabled = true;
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// HEADER BUTTONS
// ═══════════════════════════════════════════════════════════════════════════

if (closeBtn) {
  closeBtn.addEventListener('click', () => {
    try {
      if (window.top && window.top !== window) {
        window.parent.postMessage({ type: 'BULKYGEN_CLOSE_PANEL' }, '*');
        return;
      }
    } catch { }
    window.close();
  });
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    const optionsUrl = (globalThis.chrome || globalThis.browser)?.runtime?.getURL('settings.html');
    if (optionsUrl) window.open(optionsUrl, '_blank');
  });
}

// Generator navigation
if (goToGeneratorBtn && generatorSelect) {
  goToGeneratorBtn.addEventListener('click', async () => {
    const selected = generatorSelect.value;
    let url;
    switch (selected) {
      case 'flow':
        await syncFlowProjectIdFromActiveTab();
        url = await getMappedFlowProjectUrl();
        break;
      case 'metaai': url = METAAI_MEDIA_URL; break;
      case 'grok': url = GROK_URL; break;
      case 'digen': url = DIGEN_IMAGE_URL; break;
      case 'gentube': url = GENTUBE_CREATE_URL; break;
      case 'firefly': url = FIREFLY_CREATE_URL; break;
      default:
        await syncFlowProjectIdFromActiveTab();
        url = await getMappedFlowProjectUrl();
    }
    await navigateTo(url);
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// ZIP DOWNLOAD (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════

if (downloadZipBtn) {
  downloadZipBtn.addEventListener('click', async () => {
    const data = await ext.storage.local.get(['generatedImages', 'queue']);
    if (!data.generatedImages || data.generatedImages.length === 0) {
      alert('No images to download'); return;
    }
    downloadZipBtn.disabled = true;
    downloadZipBtn.textContent = 'Creating ZIP...';
    try {
      const response = await ext.runtime.sendMessage({ action: 'downloadZip', images: data.generatedImages });
      if (!response || !response.success) {
        console.error('ZIP failed:', response?.error);
        alert('ZIP failed - see console for details');
      }
    } catch (error) {
      console.error('ZIP error:', error);
      alert('ZIP error - see console');
    } finally {
      downloadZipBtn.disabled = false;
      downloadZipBtn.textContent = '📦 ZIP';
    }
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// FOOTER (reset sequence, clear images, donate)
// ═══════════════════════════════════════════════════════════════════════════

if (resetSeqBtn) {
  resetSeqBtn.addEventListener('click', async () => {
    if (confirm('Reset download numbering to 1?')) {
      await ext.storage.local.set({ bulkygenDownloadSeq: 0 });
    }
  });
}

if (clearImagesBtn) {
  clearImagesBtn.addEventListener('click', async () => {
    if (confirm('Clear all stored images from memory?')) {
      await ext.runtime.sendMessage({ action: 'clearAllImages' }).catch(() => { });
      await ext.storage.local.set({ generatedImages: [] });
      imagesByItemId.clear();
      renderQueue([]);
      if (downloadZipBtn) downloadZipBtn.disabled = true;
    }
  });
}

if (donateBtn && donateModal) {
  donateBtn.addEventListener('click', () => {
    donateModal.style.display = '';
    donateModal.setAttribute('aria-hidden', 'false');
  });
}

if (donateModal) {
  donateModal.addEventListener('click', (e) => {
    const close = e.target.closest?.('[data-action="close-donate"]');
    const backdrop = e.target.classList.contains('modal-backdrop');
    if (close || backdrop) {
      donateModal.style.display = 'none';
      donateModal.setAttribute('aria-hidden', 'true');
    }
  });
}

if (buyCodeBtn) {
  buyCodeBtn.addEventListener('click', () => {
    window.open('https://store.dodopayments.com/binayastore', '_blank');
  });
}

if (imageModal) {
  imageModal.addEventListener('click', (e) => {
    const close = e.target.closest?.('[data-action="close"]');
    if (close) { closeImageModal(); return; }
    const backdrop = e.target.classList.contains('modal-backdrop');
    if (backdrop) { closeImageModal(); return; }
    const thumb = e.target.closest?.('.modal-thumb');
    if (thumb) {
      const url = thumb.getAttribute('data-url');
      if (url) {
        const isVideo = url.startsWith('data:video/') || thumb.tagName === 'VIDEO';
        let modalVideo = imageModal.querySelector('#modalVideo');
        if (isVideo) {
          if (modalImage) modalImage.style.display = 'none';
          if (!modalVideo) {
            modalVideo = document.createElement('video');
            modalVideo.id = 'modalVideo'; modalVideo.controls = true; modalVideo.autoplay = true; modalVideo.loop = true;
            modalVideo.style.maxWidth = '100%'; modalVideo.style.maxHeight = '70vh'; modalVideo.style.borderRadius = '8px';
            modalImage?.parentElement.insertBefore(modalVideo, modalImage);
          }
          modalVideo.src = url; modalVideo.style.display = '';
        } else {
          if (modalVideo) modalVideo.style.display = 'none';
          if (modalImage) { modalImage.style.display = ''; modalImage.src = url; }
        }
      }
    }
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// RUNNING STATE (preserved from original, adapted for new layout)
// ═══════════════════════════════════════════════════════════════════════════

function setRunningState(isRunning, isPaused = false) {
  if (isRunning) {
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.innerHTML = '<span class="btn-spinner"></span> ' + (isPaused ? 'Paused' : 'Generating...');
    }
    if (pauseBtn) {
      pauseBtn.style.display = '';
      pauseBtn.disabled = false;
      if (isPaused) {
        pauseBtn.innerHTML = '<span class="btn-icon">▶</span> Resume';
        pauseBtn.classList.add('btn-resume');
        pauseBtn.classList.remove('btn-pause');
      } else {
        pauseBtn.innerHTML = '<span class="btn-icon">⏸</span> Pause';
        pauseBtn.classList.add('btn-pause');
        pauseBtn.classList.remove('btn-resume');
      }
    }
    if (stopBtn) stopBtn.disabled = false;
    if (promptInput) promptInput.disabled = true;
    if (delayInput) delayInput.disabled = true;
  } else {
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '▶ Start';
    }
    if (pauseBtn) {
      pauseBtn.style.display = 'none';
      pauseBtn.disabled = true;
      pauseBtn.innerHTML = '<span class="btn-icon">⏸</span> Pause';
      pauseBtn.classList.add('btn-pause');
      pauseBtn.classList.remove('btn-resume');
    }
    if (stopBtn) stopBtn.disabled = true;
    if (promptInput) promptInput.disabled = false;
    if (delayInput) delayInput.disabled = false;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// QUEUE RENDERING (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════

function renderQueue(queue) {
  if (!queueList) return;

  if (!queue || queue.length === 0) {
    queueList.innerHTML = '<div class="empty-queue">No prompts in queue</div>';
    return;
  }

  queueList.innerHTML = queue.map(item => {
    const statusEmoji = item.status === 'completed' ? '✓' :
      item.status === 'processing' ? '⏳' :
        item.status === 'error' ? '✗' : '○';

    const imgs = getImagesForItem(item.id);
    const latestRecord = imgs[0];
    const latest = latestRecord?.data;
    const count = imgs.length;
    const isEditing = editingItemId === item.id;

    const isVideo = latest && (latest.startsWith('data:video/') || latestRecord?.meta?.src?.includes('.mp4'));

    const promptHtml = isEditing
      ? `<div class="queue-edit-wrap"><textarea class="queue-edit" data-field="editPrompt" rows="2">${escapeHtml(item.prompt)}</textarea></div>`
      : `<span class="queue-text">${escapeHtml(item.prompt)}</span>`;

    let thumbHtml;
    if (latest) {
      if (isVideo) {
        thumbHtml = `<button class="queue-thumb-btn" data-action="openImage" title="View video"><video class="queue-thumb" src="${latest}" muted preload="metadata"></video></button>`;
      } else {
        thumbHtml = `<button class="queue-thumb-btn" data-action="openImage" title="View images"><img class="queue-thumb" src="${latest}" alt="thumb" /></button>`;
      }
    } else {
      thumbHtml = `<span class="queue-thumb-count" title="No images yet">0</span>`;
    }

    const countHtml = latest ? `<span class="queue-thumb-count" title="${count} image(s)">${count}</span>` : '';

    const actionsHtml = isEditing
      ? `<div class="queue-actions">
           <button class="mini-btn" data-action="update" title="Update">Update</button>
           <button class="mini-btn" data-action="cancel" title="Cancel">Cancel</button>
         </div>`
      : `<div class="queue-actions">
           ${thumbHtml} ${countHtml}
           <button class="mini-btn" data-action="edit" title="Edit">✎</button>
           <button class="mini-btn" data-action="retry" title="Retry">↻</button>
         </div>`;

    return `<div class="queue-item ${item.status}" data-id="${item.id}">
      ${promptHtml} ${actionsHtml}
      <span class="queue-status">${statusEmoji}</span>
    </div>`;
  }).join('');
}


// ═══════════════════════════════════════════════════════════════════════════
// QUEUE CLICK HANDLING (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════

if (queueList) {
  queueList.addEventListener('click', async (e) => {
    const itemEl = e.target.closest?.('.queue-item');
    if (!itemEl) return;
    const id = Number(itemEl.getAttribute('data-id'));
    if (!id) return;

    const actionBtn = e.target.closest?.('button[data-action]');
    const action = actionBtn?.getAttribute('data-action');

    if (action === 'openImage') {
      const imgs = getImagesForItem(id);
      const latest = imgs[0]?.data;
      if (latest) openImageModal(id, latest);
      return;
    }

    if (action === 'edit') {
      editingItemId = id;
      const data = await ext.storage.local.get(['queue', 'generatedImages']);
      await rebuildImagesIndex(data.generatedImages || []);
      renderQueue(data.queue || []);
      return;
    }

    if (action === 'cancel') {
      editingItemId = null;
      const data = await ext.storage.local.get(['queue', 'generatedImages']);
      await rebuildImagesIndex(data.generatedImages || []);
      renderQueue(data.queue || []);
      return;
    }

    if (action === 'update') {
      const editEl = itemEl.querySelector('textarea[data-field="editPrompt"]');
      const newPrompt = (editEl?.value || '').trim();
      if (!newPrompt) return;
      const data = await ext.storage.local.get(['queue']);
      const queue = data.queue || [];
      const idx = queue.findIndex(q => q.id === id);
      if (idx === -1) return;
      queue[idx].prompt = newPrompt;
      queue[idx].status = 'pending';
      await ext.storage.local.set({ queue });
      editingItemId = null;
      renderQueue(queue);
      setRunningState(true);
      await ext.runtime.sendMessage({ action: 'regenerateItem', itemId: id });
      return;
    }

    if (action === 'retry') {
      const data = await ext.storage.local.get(['queue']);
      const queue = data.queue || [];
      const idx = queue.findIndex(q => q.id === id);
      if (idx === -1) return;
      queue[idx].status = 'pending';
      await ext.storage.local.set({ queue });
      renderQueue(queue);
      setRunningState(true);
      await ext.runtime.sendMessage({ action: 'regenerateItem', itemId: id });
    }
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND MESSAGE LISTENER (preserved + extended)
// ═══════════════════════════════════════════════════════════════════════════

function updateUI() {
  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'updateQueue') {
      renderQueue(message.queue);
      const completed = message.queue.filter(item => item.status === 'completed').length;
      if (downloadZipBtn) downloadZipBtn.disabled = completed === 0;
    }

    if (message.action === 'imageSaved') {
      ext.storage.local.get(['generatedImages', 'queue']).then(async data => {
        await rebuildImagesIndex(data.generatedImages || []);
        renderQueue(data.queue || []);
        if (modalItemId && modalThumbs) {
          const imgs = getImagesForItem(modalItemId);
          modalThumbs.innerHTML = imgs.map(im => {
            const url = im.data;
            const isVid = url && (url.startsWith('data:video/') || im.meta?.src?.includes('.mp4'));
            if (isVid) return `<video class="modal-thumb" src="${url}" data-url="${url}" muted preload="metadata"></video>`;
            return `<img class="modal-thumb" src="${url}" data-url="${url}" alt="thumb" />`;
          }).join('');
        }
      });
    }

    if (message.action === 'generationComplete') {
      setRunningState(false);
    }

    if (message.action === 'generationError') {
      setRunningState(false);
      alert(message.message || 'An error occurred during generation');
    }

    // Pipeline messages (autonomous mode)
    if (message.action === 'pipelineRecordComplete') {
      refreshDashboardStats();
    }
    if (message.action === 'pipelineStatusUpdate') {
      refreshDashboardStats();
    }
  });
}
