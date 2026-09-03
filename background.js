// Background service worker
importScripts('ext.js');
importScripts('image_store.js');

// ── Pipeline modules ────────────────────────────────────────────────────────
importScripts('modules/logger.js');
importScripts('modules/settings.js');
importScripts('modules/statistics.js');
importScripts('modules/supabase.js');
importScripts('modules/canvas-processor.js');
importScripts('modules/metadata/piexif.js');
importScripts('modules/metadata/metadata-mapper.js');
importScripts('modules/metadata/xmp-serializer.js');
importScripts('modules/metadata/exif-serializer.js');
importScripts('modules/metadata/iptc-serializer.js');
importScripts('modules/metadata/png-serializer.js');
importScripts('modules/metadata/webp-serializer.js');
importScripts('modules/metadata/metadata-engine.js');
importScripts('modules/metadata-writer.js');
importScripts('modules/googleAuth.js');
importScripts('modules/googleDrive.js');
importScripts('modules/pipeline.js');

// --- Split-out modules (see background/*.js) ---
importScripts('background/state-and-status.js');
importScripts('background/keepalive.js');
importScripts('background/messaging.js');
importScripts('background/generation-support.js');
importScripts('background/generation-loop.js');
importScripts('background/tab-lifecycle.js');
importScripts('background/image-export.js');


// ── Auto-start autonomous pipeline on boot ──────────────────────────────────
// Also restores persisted log entries and applies the user's log level setting.
(async () => {
  try {
    // Phase 15: restore persisted log entries into in-memory buffer
    if (globalThis.bulkygenLogger) {
      await globalThis.bulkygenLogger.restore();
    }

    if (globalThis.bulkygenSettings) {
      await globalThis.bulkygenSettings.load();
      const settings = await globalThis.bulkygenSettings.get();

      // Phase 18: apply debug log level from user settings
      if (globalThis.bulkygenLogger && settings.logLevel) {
        globalThis.bulkygenLogger.setLevel(settings.debugMode ? 'verbose' : settings.logLevel);
        globalThis.bulkygenLogger.info('Background', `Log level set to: ${settings.debugMode ? 'verbose' : settings.logLevel}`);
      }

      // Auto-start pipeline if autonomousMode is enabled
      if (settings && settings.autonomousMode) {
        if (globalThis.bulkygenPipeline && !globalThis.bulkygenPipeline.isRunning) {
          console.log('BulkyGen: Auto-starting autonomous pipeline on boot');
          startSwKeepAlive();
          armKeepAliveAlarm();
          ext.storage.local.set({ pipelineRunning: true }).catch(() => { });
          globalThis.bulkygenPipeline.start();
        }
      }
    }
  } catch (e) {
    console.warn('BulkyGen: Auto-start pipeline check failed:', e);
  }
})();