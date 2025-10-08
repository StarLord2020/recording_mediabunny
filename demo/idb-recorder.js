'use strict';

const DB_NAME = 'rec-db';
const SESS = 'sessions';
const CHUNKS = 'chunks';

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESS)) {
        const sessStore = db.createObjectStore(SESS, { keyPath: 'id' });
        sessStore.createIndex('byRoom', 'roomId');
      }
      if (!db.objectStoreNames.contains(CHUNKS)) {
        const s = db.createObjectStore(CHUNKS, { keyPath: ['sessionId','seq'] });
        s.createIndex('bySession','sessionId');
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

class IDBWriter {
  constructor() {
    this.dbPromise = openDB();
    this.queue = [];
    this.pumping = false;
    this.seq = 0;
    this.sessionId = null;
    this.mimeType = '';
  }

  async flush() {
    // Wait until internal queue is drained and the last tx completes
    // Small backoff loop to avoid busy waiting
    for (let i = 0; i < 500; i++) { // ~5s max at 10ms
      if (!this.pumping && this.queue.length === 0) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 10));
    }
    // Give IDB a moment to finalize the last transaction
    await new Promise(r => setTimeout(r, 20));
  }

  async start({ filenameBase, mimeType, roomId }) {
    const db = await this.dbPromise;
    this.sessionId = crypto.randomUUID();
    this.mimeType = mimeType || '';
    await new Promise((res, rej) => {
      const tx = db.transaction(SESS, 'readwrite');
      tx.objectStore(SESS).put({
        id: this.sessionId, filenameBase, mimeType: this.mimeType,
        startedAt: Date.now(), stoppedAt: null, chunkCount: 0, status: 'recording', roomId
      });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    await this.cleanupOldSessions(db);
    return this.sessionId;
  }

  enqueue(blob) {
    this.queue.push(blob);
    if (!this.pumping) this._pump();
  }

  async _pump() {
    this.pumping = true;
    const db = await this.dbPromise;
    while (this.queue.length) {
      const blob = this.queue.shift();
      await new Promise((res, rej) => {
        const tx = db.transaction([CHUNKS, SESS], 'readwrite');
        tx.objectStore(CHUNKS).put({ sessionId: this.sessionId, seq: this.seq++, blob });
        const sessStore = tx.objectStore(SESS);
        const get = sessStore.get(this.sessionId);
        get.onsuccess = () => {
          const s = get.result; s.chunkCount = this.seq; sessStore.put(s);
        };
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      }).catch((error) => {
        console.error('IDBWriter pump error:', error);
      });
    }
    this.pumping = false;
  }

  async stop() {
    const db = await this.dbPromise;
    await new Promise((res, rej) => {
      const tx = db.transaction(SESS, 'readwrite');
      const get = tx.objectStore(SESS).get(this.sessionId);
      get.onsuccess = () => {
        const s = get.result; if (s) { s.status = 'stopped'; s.stoppedAt = Date.now(); tx.objectStore(SESS).put(s); }
      };
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  async cleanupOldSessions(db, keepCount = Infinity) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([SESS, CHUNKS], 'readwrite');
      const sessStore = tx.objectStore(SESS);
      const getAllReq = sessStore.getAll();

      getAllReq.onsuccess = () => {
        let sessions = getAllReq.result;
        if (Number.isFinite(keepCount) && sessions.length > keepCount) {
          sessions.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
          const toDelete = sessions.slice(0, sessions.length - keepCount);
          toDelete.forEach(sess => {
            sessStore.delete(sess.id);
            const chunkIndex = tx.objectStore(CHUNKS).index('bySession');
            const cursorReq = chunkIndex.openCursor(IDBKeyRange.only(sess.id));
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (cursor) {
                cursor.delete();
                cursor.continue();
              }
            };
          });
        }
      };

      getAllReq.onerror = () => reject(getAllReq.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

async function assembleAndDownload(sessionId, fileName) {
  const db = await openDB();
  const sess = await new Promise((res, rej) => {
    const tx = db.transaction(SESS, 'readonly');
    const r = tx.objectStore(SESS).get(sessionId);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  if (!sess) throw new Error('Session not found');

  const rows = await new Promise((res, rej) => {
    const tx = db.transaction(CHUNKS,'readonly');
    const idx = tx.objectStore(CHUNKS).index('bySession');
    const req = idx.getAll(IDBKeyRange.only(sessionId));
    req.onsuccess = () => res(req.result.sort((a,b)=>a.seq-b.seq));
    req.onerror = () => rej(req.error);
  });

  const parts = rows.map((r) => r.blob || new Blob([r.ab], { type: sess.mimeType }));
  const blob = new Blob(parts, { type: sess.mimeType });
  const isMp4 = (sess.mimeType || '').startsWith('video/mp4');
  const name = fileName || `${sess.filenameBase || 'recording'}.${isMp4 ? 'mp4' : 'webm'}`;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

async function listSessions() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(SESS,'readonly');
    const req = tx.objectStore(SESS).getAll();
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
}

async function deleteSession(sessionId) {
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction([SESS,CHUNKS],'readwrite');
    tx.objectStore(SESS).delete(sessionId);
    const idx = tx.objectStore(CHUNKS).index('bySession');
    const c = idx.openCursor(IDBKeyRange.only(sessionId));
    c.onsuccess = () => { const cur = c.result; if (cur) { cur.delete(); cur.continue(); } };
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

async function requestPersistence() {
  if (navigator.storage?.persist) {
    const persisted = await navigator.storage.persisted();
    if (!persisted) await navigator.storage.persist();
  }
}

async function getSessionsByRoom(roomId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readonly');
    const index = tx.objectStore('sessions').index('byRoom');
    const req = index.getAll(roomId);
    req.onsuccess = () => {
      const result = req.result || [];
      result.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      resolve(result);
    };
    req.onerror = () => reject(req.error);
  });
}

async function getStorageUsageInfo() {
  if (!navigator.storage?.estimate) {
    throw new Error('StorageManager API не поддерживается');
  }
  const { usage, quota } = await navigator.storage.estimate();
  return {
    usageBytes: usage,
    quotaBytes: quota,
    usageMB: (usage / 1024 / 1024).toFixed(1),
    quotaMB: (quota / 1024 / 1024).toFixed(1),
    usagePercent: ((usage / quota) * 100).toFixed(1)
  };
}

// expose helpers on window (demo scope)
window.IDBWriter = IDBWriter;
window.idbOpenDB = openDB;
window.idbAssembleAndDownload = assembleAndDownload;
window.idbListSessions = listSessions;
window.idbDeleteSession = deleteSession;
window.idbRequestPersistence = requestPersistence;
window.idbGetSessionsByRoom = getSessionsByRoom;
window.idbGetStorageUsageInfo = getStorageUsageInfo;
