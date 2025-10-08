/* Service Worker for streaming download of remuxed sessions without buffering whole file. */
/* global self */

// Load Mediabunny UMD inside SW scope
try { importScripts('./mediabunny.umd.js'); } catch (e) {}

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

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/sw-download') {
    event.respondWith(handleDownload(url, event.clientId));
  }
});

async function handleDownload(url, clientId) {
  try {
    const sessionId = url.searchParams.get('session');
    const filename = url.searchParams.get('name') || `session-${new Date().toISOString().replace(/[:.]/g,'-')}.webm`;
    const mimeType = 'video/webm';
    if (!sessionId) return new Response('Missing session', { status: 400 });
    if (!self.Mediabunny) return new Response('Mediabunny not available in SW', { status: 500 });

  const { Input, Output, WebMOutputFormat, StreamTarget, Conversion } = self.Mediabunny;

  // Prepare client messaging first
  const client = clientId ? await self.clients.get(clientId) : null;
  const send = (payload) => { try { client?.postMessage({ source: 'mb-sw', ...payload }); } catch(_) {} };

  // Streaming sink with reordering: emits contiguous bytes only (low RAM)
  let rsController = null;
  const readable = new ReadableStream({ start(c) { rsController = c; send({ type:'sw-log', phase:'stream', message:'readable started' }); } });
  let nextOffset = 0;
  const pending = new Map();
  const tryFlush = () => {
    while (true) {
      const chunk = pending.get(nextOffset);
      if (!chunk) break;
      pending.delete(nextOffset);
      rsController.enqueue(chunk);
      nextOffset += chunk.byteLength;
    }
  };
  const writable = new WritableStream({
    async write(chunk) {
      try {
        const position = (chunk && typeof chunk.position === 'number') ? chunk.position : undefined;
        const data = (chunk && chunk.data !== undefined) ? chunk.data : chunk;
        let u8;
        if (data instanceof Uint8Array) u8 = data;
        else if (data?.buffer) u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length || 0);
        else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
        else { const ab = await new Blob([data]).arrayBuffer(); u8 = new Uint8Array(ab); }
        const pos = (position === undefined) ? nextOffset : position;
        if (pos === nextOffset) {
          rsController.enqueue(u8);
          nextOffset += u8.byteLength;
          tryFlush();
        } else if (pos > nextOffset) {
          pending.set(pos, u8);
        } else {
          // cannot rewrite already-sent bytes
        }
      } catch (err) {
        send({ type:'sw-error', phase:'sink-write', message: String(err && err.message || err) });
        try { rsController.close(); } catch(_) {}
        throw err;
      }
    },
    close() { try { tryFlush(); rsController.close(); send({ type:'sw-log', phase:'stream', message:'readable closed' }); } catch(_) {} },
    abort(reason) { send({ type:'sw-error', phase:'sink-abort', message: String(reason||'') }); try { rsController.close(); } catch(_) {} }
  }, { highWaterMark: 1 });

    try {
      const db = await openDB();
      // Build sizes/prefix (index)
      send({ type: 'sw-log', phase: 'index', message: 'start' });
      const sess = await new Promise((res, rej) => { const tx = db.transaction(SESS,'readonly'); const r = tx.objectStore(SESS).get(sessionId); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (!sess) throw new Error('Session not found');
      const count = Number.isInteger(sess.chunkCount) ? sess.chunkCount : 0;
      if (count <= 0) throw new Error('No chunks');
      const sizes = new Array(count); let total = 0;
      for (let i = 0; i < count; i++) {
        const tx = db.transaction(CHUNKS,'readonly'); const store = tx.objectStore(CHUNKS);
        // eslint-disable-next-line no-await-in-loop
        const row = await new Promise((res, rej) => { const g = store.get([sessionId, i]); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
        const sz = row?.blob ? row.blob.size : (row?.ab ? row.ab.byteLength : 0);
        sizes[i] = sz; total += sz;
        if ((i & 0xFF) === 0 || i === count-1) send({ type: 'sw-log', phase: 'index', progress: (i+1)/count });
      }
      const prefix = new Array(count); let acc = 0; for (let i = 0; i < count; i++) { prefix[i] = acc; acc += sizes[i]; }
      const locate = (offset) => {
        let lo = 0, hi = count - 1, ans = 0;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (prefix[mid] <= offset) { ans = mid; lo = mid + 1; } else { hi = mid - 1; } }
        const seq = ans; const chunkOffset = offset - prefix[seq]; return { seq, chunkOffset };
      };
      // Create random-access StreamSource
      let served = 0;
      const source = new self.Mediabunny.StreamSource({
        getSize: () => total,
        read: async (start, end) => {
          const len = end - start; const out = new Uint8Array(len);
          let written = 0; let pos = start;
          while (written < len) {
            const { seq, chunkOffset } = locate(pos);
            const tx = db.transaction(CHUNKS,'readonly'); const store = tx.objectStore(CHUNKS);
            // eslint-disable-next-line no-await-in-loop
            const row = await new Promise((res, rej) => { const g = store.get([sessionId, seq]); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
            if (!row) throw new Error('Missing chunk');
            const blob = row.blob || new Blob([row.ab], { type: mimeType });
            const take = Math.min(blob.size - chunkOffset, len - written);
            let ab;
            try {
              // eslint-disable-next-line no-await-in-loop
              ab = await blob.slice(chunkOffset, chunkOffset + take).arrayBuffer();
              out.set(new Uint8Array(ab), written);
            } catch (err) {
              send({ type:'sw-error', phase:'read-slice', message:`seq=${seq} offset=${chunkOffset} len=${take} err=${String(err && err.message || err)}` });
              throw err;
            }
            written += (ab?.byteLength || 0); pos += (ab?.byteLength || 0);
          }
          served += len; if ((served & ((1<<22)-1)) === 0) send({ type: 'sw-log', phase: 'bytes', progress: served/total });
          return out;
        },
        maxCacheSize: 128 * 1024 * 1024,
        prefetchProfile: 'fileSystem'
      });
      const input = new Input({ source, formats: [self.Mediabunny.WEBM] });
      const target = new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 });
      const output = new Output({ format: new WebMOutputFormat({ appendOnly: true }), target });
      const conversion = await Conversion.init({ input, output });
      conversion.onProgress = (p) => { try { send({ type:'sw-log', phase:'lib', progress: Math.max(0, Math.min(1, p||0)) }); } catch(_) {} };
      send({ type: 'sw-log', phase: 'convert', message: 'start' });
      await conversion.execute();
      send({ type: 'sw-log', phase: 'done', message: 'complete' });
    } catch (e) {
      send({ type: 'sw-error', message: String(e && e.message || e) });
      try { const writer = writable.getWriter?.(); await writer?.abort?.(e); } catch(_) {}
    }
    const headers = new Headers({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    return new Response(readable, { status: 200, headers });
  } catch (err) {
    return new Response('SW init error: ' + String(err && err.message || err), { status: 500 });
  }
}
