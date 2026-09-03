// Part of background.js, split out for readability. Runs in the same
// service-worker global scope as background.js and the other
// background/*.js files (loaded via importScripts — NOT ES modules),
// so everything here shares state (isRunning, isPaused, etc.) with them
// exactly as it did when this was all one file.




// ---------------------------------------------------------------------------
// Background resilience: keep the MV3 service worker alive during a run and
// resurrect the loop if the worker is ever killed (e.g. when the user switches
// to another tab / window / app). Without this, a single long image wait can
// outlast the ~30s service-worker idle timeout and silently stop generation.
// ---------------------------------------------------------------------------
const KEEPALIVE_ALARM = 'bulkygen-keepalive';
let swKeepAliveTimer = null;

function startSwKeepAlive() {
  if (swKeepAliveTimer) return;
  // Calling a real extension API on an interval keeps resetting the worker's
  // idle timer so it is never torn down mid-generation.
  swKeepAliveTimer = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; }); } catch (e) { }
  }, 20000);
}
function stopSwKeepAlive() {
  if (swKeepAliveTimer) { clearInterval(swKeepAliveTimer); swKeepAliveTimer = null; }
}
function armKeepAliveAlarm() {
  try { chrome.alarms && chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); } catch (e) { }
}
function disarmKeepAliveAlarm() {
  try { chrome.alarms && chrome.alarms.clear(KEEPALIVE_ALARM); } catch (e) { }
}

// Watchdog: fires even when the tab is backgrounded. Resumes the run from
// storage if the worker had been killed (loopActive === false but isRunning).
if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    try {
      const data = await ext.storage.local.get(['isRunning', 'isPaused', 'genTabId', 'pipelineRunning']);

      // Resurrect the autonomous pipeline if the worker was killed mid-run.
      // (bulkygenPipeline.isRunning lives in memory, so after a worker restart
      // it's always false even though pipelineRunning in storage says it should
      // still be active — that mismatch is exactly the "worker got killed" signal.)
      if (data.pipelineRunning && globalThis.bulkygenPipeline && !globalThis.bulkygenPipeline.isRunning) {
        startSwKeepAlive();
        console.log('\u23f0 Watchdog: resuming autonomous pipeline after worker wake');
        globalThis.bulkygenPipeline.start(true);
      } else if (!data.pipelineRunning && data.isRunning && !loopActive) {
        startSwKeepAlive();
        isPaused = !!data.isPaused;
        console.log('\u23f0 Watchdog: resuming generation after worker wake');
        tryStartGeneration(typeof data.genTabId === 'number' ? data.genTabId : undefined);
      } else if (!data.isRunning && !data.pipelineRunning) {
        disarmKeepAliveAlarm();
        stopSwKeepAlive();
      }
    } catch (e) { }
  });
}

// Re-arm keep-alive whenever the worker spins back up while a run is active.
try {
  ext.storage.local.get(['isRunning', 'pipelineRunning']).then((d) => {
    if (d && (d.isRunning || d.pipelineRunning)) { startSwKeepAlive(); armKeepAliveAlarm(); }
    if (d && d.pipelineRunning && globalThis.bulkygenPipeline && !globalThis.bulkygenPipeline.isRunning) {
      console.log('\u23f0 Startup: resuming autonomous pipeline after worker restart');
      globalThis.bulkygenPipeline.start(true);
    }
  }).catch(() => { });
} catch (e) { }

// Enable native auto-open for the extension side panel.
try {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
} catch (e) {
  console.warn('setPanelBehavior not supported:', e);
}

// Fallback click behavior if side panel isn't completely natively handled by ActionClick.
// Since openPanelOnActionClick is true, the browser SHOULD handle opening the side panel automatically.
// The listener remains mostly empty here, but if needed, we keep it small to avoid conflicts.
chrome.action.onClicked.addListener(async (tab) => {
  console.log('Action icon clicked. Native sidePanel behavior should handle this.');
});