/**
 * BulkyGen Logger Module
 * Structured logging with levels, circular buffer, and export.
 * Usage: import via importScripts() in background, or <script src> in pages.
 */
(function () {
  'use strict';

  const LOG_LEVELS = { verbose: 0, info: 1, warn: 2, error: 3 };
  const MAX_BUFFER = 1000;   // keep last 1000 entries in memory
  const PERSIST_KEY = 'bulkygen_logs';
  const PERSIST_MAX = 200;   // entries saved to storage

  let _minLevel = LOG_LEVELS.info;
  const _buffer = [];

  function _ts() {
    return new Date().toISOString();
  }

  function _store(level, tag, msg, data) {
    const entry = { ts: _ts(), level, tag, msg, data: data !== undefined ? data : null };
    _buffer.push(entry);
    if (_buffer.length > MAX_BUFFER) _buffer.shift();
    return entry;
  }

  function _format(level, tag, msg) {
    const prefix = `[BulkyGen][${level.toUpperCase()}][${tag}]`;
    return `${prefix} ${msg}`;
  }

  function _log(levelName, tag, msg, data) {
    if (LOG_LEVELS[levelName] < _minLevel) return;
    const entry = _store(levelName, tag, msg, data);
    const formatted = _format(levelName, tag, msg);
    switch (levelName) {
      case 'error': console.error(formatted, data !== undefined ? data : ''); break;
      case 'warn':  console.warn(formatted,  data !== undefined ? data : ''); break;
      default:      console.log(formatted,   data !== undefined ? data : ''); break;
    }
    return entry;
  }

  /**
   * Set minimum log level ('verbose' | 'info' | 'warn' | 'error').
   */
  function setLevel(levelName) {
    if (LOG_LEVELS[levelName] !== undefined) {
      _minLevel = LOG_LEVELS[levelName];
    }
  }

  const logger = {
    verbose: (tag, msg, data) => _log('verbose', tag, msg, data),
    info:    (tag, msg, data) => _log('info',    tag, msg, data),
    warn:    (tag, msg, data) => _log('warn',    tag, msg, data),
    error:   (tag, msg, data) => _log('error',   tag, msg, data),
    setLevel,

    /** Return a copy of the in-memory buffer. */
    getBuffer() { return _buffer.slice(); },

    /** Return only error-level entries. */
    getErrors() { return _buffer.filter(e => e.level === 'error'); },

    /** Export buffer as a formatted text string. */
    exportText() {
      return _buffer
        .map(e => `${e.ts} [${e.level.toUpperCase()}][${e.tag}] ${e.msg}${e.data ? ' | ' + JSON.stringify(e.data) : ''}`)
        .join('\n');
    },

    /** Persist recent entries to chrome.storage.local. */
    async persist() {
      try {
        const storage = (globalThis.chrome || globalThis.browser)?.storage?.local;
        if (!storage) return;
        const recent = _buffer.slice(-PERSIST_MAX);
        await new Promise((res, rej) => storage.set({ [PERSIST_KEY]: recent }, () => {
          const err = (globalThis.chrome || globalThis.browser)?.runtime?.lastError;
          err ? rej(new Error(err.message)) : res();
        }));
      } catch (e) { /* non-fatal */ }
    },

    /** Load persisted entries back into the buffer. */
    async restore() {
      try {
        const storage = (globalThis.chrome || globalThis.browser)?.storage?.local;
        if (!storage) return;
        const data = await new Promise((res, rej) => storage.get([PERSIST_KEY], (d) => {
          const err = (globalThis.chrome || globalThis.browser)?.runtime?.lastError;
          err ? rej(new Error(err.message)) : res(d);
        }));
        const saved = data[PERSIST_KEY];
        if (Array.isArray(saved)) {
          for (const e of saved) _buffer.push(e);
          if (_buffer.length > MAX_BUFFER) _buffer.splice(0, _buffer.length - MAX_BUFFER);
        }
      } catch (e) { /* non-fatal */ }
    }
  };

  globalThis.bulkygenLogger = logger;
})();
