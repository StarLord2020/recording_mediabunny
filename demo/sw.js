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
    event.respondWith(handleDownload(url));
  }
});

async function handleDownload(url) {
  const sessionId = url.searchParams.get('session');
  const filename = url.searchParams.get('name') || `session-${new Date().toISOString().replace(/[:.]/g,'-')}.webm`;
  const mimeType = 'video/webm';
  if (!sessionId) return new Response('Missing session', { status: 400 });
  if (!self.Mediabunny) return new Response('Mediabunny not available in SW', { status: 500 });

  const { Input, Output, WebMOutputFormat, StreamTarget, ReadableStreamSource, Conversion } = self.Mediabunny;

  const ts = new TransformStream();
  const writable = ts.writable;
  const readable = ts.readable;

  (async () => {
    try {
      const db = await openDB();
      let nextSeq = 0; let done = false;
      const stream = new ReadableStream({
        async pull(controller) {
          if (done) { controller.close(); return; }
          const tx = db.transaction(CHUNKS,'readonly');
          const store = tx.objectStore(CHUNKS);
          const row = await new Promise((res, rej) => { const g = store.get([sessionId, nextSeq]); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
          if (!row) { done = true; controller.close(); return; }
          const blob = row.blob || new Blob([row.ab], { type: mimeType });
          const ab = await blob.arrayBuffer();
          controller.enqueue(new Uint8Array(ab));
          nextSeq = (row.seq || nextSeq) + 1;
        }
      });
      const input = new Input({ source: new ReadableStreamSource(stream, { maxCacheSize: 64 * 1024 * 1024 }), formats: [self.Mediabunny.WEBM] });
      const target = new StreamTarget(writable, { chunked: true, chunkSize: 16 * 1024 * 1024 });
      const output = new Output({ format: new WebMOutputFormat(), target });
      const conversion = await Conversion.init({ input, output });
      await conversion.execute();
    } catch (e) {
      try { const writer = writable.getWriter?.(); await writer?.abort?.(e); } catch(_) {}
    }
  })();

  const headers = new Headers({
    'Content-Type': mimeType,
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  return new Response(readable, { status: 200, headers });
}

