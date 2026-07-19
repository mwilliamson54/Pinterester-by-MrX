// Simple IndexedDB-based image store for BulkyGen.
// Stores image blobs outside chrome.storage.local quota.
// Exposes global `bulkygenImageStore`.

(function () {
  const DB_NAME = 'BulkyGenDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'images';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('by_itemId', 'itemId', { unique: false });
          store.createIndex('by_timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  async function putImage(record) {
    if (!record || !record.id) throw new Error('Image record missing id');
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    await txDone(tx);
    db.close();
    return record.id;
  }

  async function getImage(id) {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    const result = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('IndexedDB get failed'));
    });
    await txDone(tx);
    db.close();
    return result;
  }

  async function getAllImages() {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    const result = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('IndexedDB getAll failed'));
    });
    await txDone(tx);
    db.close();
    return result;
  }

  async function getImagesByItemId(itemId) {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const idx = tx.objectStore(STORE_NAME).index('by_itemId');
    const req = idx.getAll(itemId);
    const result = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('IndexedDB index getAll failed'));
    });
    await txDone(tx);
    db.close();
    result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return result;
  }

  async function clearAll() {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    await txDone(tx);
    db.close();
  }

  async function deleteImage(id) {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    await txDone(tx);
    db.close();
  }

  globalThis.bulkygenImageStore = {
    putImage,
    getImage,
    getAllImages,
    getImagesByItemId,
    deleteImage,
    clearAll
  };
})();
