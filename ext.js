/* Cross-browser WebExtensions API wrapper
 * Exposes a promise-based `ext` object:
 * - Firefox/Safari: uses `browser` (promise API)
 * - Chrome/Edge: wraps `chrome` callback API into promises
 */
(function () {
  const hasBrowser = typeof globalThis.browser !== 'undefined' && !!globalThis.browser?.runtime;
  if (hasBrowser) {
    globalThis.ext = globalThis.browser;
    return;
  }

  const chromeApi = typeof globalThis.chrome !== 'undefined' && !!globalThis.chrome?.runtime ? globalThis.chrome : null;
  if (!chromeApi) {
    // No extension APIs available (e.g., normal web page context)
    globalThis.ext = null;
    return;
  }

  function chromeCall(fn, thisArg, args) {
    return new Promise((resolve, reject) => {
      try {
        fn.call(thisArg, ...args, (result) => {
          const err = chromeApi.runtime?.lastError;
          if (err) reject(new Error(err.message || String(err)));
          else resolve(result);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  globalThis.ext = {
    action: chromeApi.action,
    windows: chromeApi.windows
      ? {
          create: (...args) => chromeCall(chromeApi.windows.create, chromeApi.windows, args)
        }
      : undefined,
    tabs: {
      query: (...args) => chromeCall(chromeApi.tabs.query, chromeApi.tabs, args),
      create: (...args) => chromeCall(chromeApi.tabs.create, chromeApi.tabs, args),
      update: (...args) => chromeCall(chromeApi.tabs.update, chromeApi.tabs, args),
      sendMessage: (...args) => chromeCall(chromeApi.tabs.sendMessage, chromeApi.tabs, args),
      get: (...args) => chromeCall(chromeApi.tabs.get, chromeApi.tabs, args)
    },
    runtime: {
      id: chromeApi.runtime.id,
      lastError: chromeApi.runtime.lastError,
      onMessage: chromeApi.runtime.onMessage,
      getURL: (...args) => chromeApi.runtime.getURL(...args),
      sendMessage: (...args) => chromeCall(chromeApi.runtime.sendMessage, chromeApi.runtime, args)
    },
    storage: {
      local: {
        get: (...args) => chromeCall(chromeApi.storage.local.get, chromeApi.storage.local, args),
        set: (...args) => chromeCall(chromeApi.storage.local.set, chromeApi.storage.local, args),
        clear: (...args) => chromeCall(chromeApi.storage.local.clear, chromeApi.storage.local, args)
      }
    },
    downloads: chromeApi.downloads
      ? {
          onChanged: chromeApi.downloads.onChanged,
          download: (...args) => chromeCall(chromeApi.downloads.download, chromeApi.downloads, args)
        }
      : undefined
  };
})();
