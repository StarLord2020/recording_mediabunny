// Remux Service: reusable helpers to process Mediabunny sessions from IndexedDB
// ES module; can be imported in apps with <script type="module">.

const DB_NAME = 'rec-db';
const SESS = 'sessions';
const CHUNKS = 'chunks';

async function openDB() {
  return await new Promise((res, rej) => {
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

export async function listSessions() {
  const db = await openDB();
  return await new Promise((res, rej) => {
    const tx = db.transaction(SESS,'readonly');
    const req = tx.objectStore(SESS).getAll();
    req.onsuccess = () => res(req.result||[]);
    req.onerror = () => rej(req.error);
  });
}

export async function buildSessionIndex(sessionId, mimeType='video/webm', onIndexProgress) {
  const db = await openDB();
  const sess = await new Promise((res, rej) => {
    const tx = db.transaction(SESS,'readonly');
    const r = tx.objectStore(SESS).get(sessionId);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  if (!sess) throw new Error('Session not found');
  const count = Number.isInteger(sess.chunkCount) ? sess.chunkCount : 0;
  if (count <= 0) throw new Error('Session has no chunks');
  const sizes = new Array(count); let total = 0;
  for (let i = 0; i < count; i++) {
    const tx = db.transaction(CHUNKS,'readonly'); const store = tx.objectStore(CHUNKS);
    // eslint-disable-next-line no-await-in-loop
    const row = await new Promise((res, rej) => { const g = store.get([sessionId, i]); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
    const sz = row?.blob ? row.blob.size : (row?.ab ? row.ab.byteLength : 0);
    sizes[i] = sz; total += sz;
    if (onIndexProgress && ((i & 0xFF) === 0 || i === count-1)) {
      try { onIndexProgress((i+1)/count); } catch(_) {}
      // yield to UI
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  }
  if (total <= 0) throw new Error('Total size is zero');
  const prefix = new Array(count); let acc = 0; for (let i = 0; i < count; i++) { prefix[i] = acc; acc += sizes[i]; }
  return { db, session: sess, count, sizes, prefix, totalSize: total, mimeType };
}

export function locateChunkByOffset(prefix, sizes, offset) {
  let lo = 0, hi = sizes.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] <= offset) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  const seq = ans;
  const chunkOffset = offset - prefix[seq];
  return { seq, chunkOffset };
}

export function createStreamSourceForSession(index, options={}) {
  const { StreamSource } = window.Mediabunny;
  const maxCacheSize = Math.max(0, (options.cacheMB|0) * 1024 * 1024) || (128*1024*1024);
  const prefetchProfile = options.prefetch || 'fileSystem';
  let servedBytes = 0;
  return new StreamSource({
    getSize: () => index.totalSize,
    read: async (start, end) => {
      const len = end - start; const out = new Uint8Array(len);
      let written = 0; let pos = start;
      while (written < len) {
        const { seq, chunkOffset } = locateChunkByOffset(index.prefix, index.sizes, pos);
        const tx = index.db.transaction(CHUNKS,'readonly'); const store = tx.objectStore(CHUNKS);
        // eslint-disable-next-line no-await-in-loop
        const row = await new Promise((res, rej) => { const g = store.get([index.session.id, seq]); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
        if (!row) throw new Error('Missing chunk');
        const blob = row.blob || new Blob([row.ab], { type: index.mimeType });
        const take = Math.min(blob.size - chunkOffset, len - written);
        // eslint-disable-next-line no-await-in-loop
        const ab = await blob.slice(chunkOffset, chunkOffset + take).arrayBuffer();
        out.set(new Uint8Array(ab), written);
        written += ab.byteLength; pos += ab.byteLength;
      }
      servedBytes += len;
      try { options.onByteProgress?.(Math.max(0, Math.min(1, servedBytes / index.totalSize))); } catch(_) {}
      return out;
    },
    maxCacheSize,
    prefetchProfile
  });
}

export async function computeSessionDuration(index, options={}) {
  const { Input } = window.Mediabunny;
  const source = createStreamSourceForSession(index, options);
  const input = new Input({ source, formats: [window.Mediabunny.WEBM] });
  const dur = await input.computeDuration();
  try { input.dispose?.(); } catch(_) {}
  return dur;
}

export function wrapFileWritableAsSink(fileWritable) {
  return new WritableStream({
    async write(chunk) {
      const data = chunk && chunk.data !== undefined ? chunk.data : chunk;
      const position = chunk && typeof chunk.position === 'number' ? chunk.position : undefined;
      let u8;
      if (data instanceof Uint8Array) u8 = data;
      else if (data?.buffer) u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length || 0);
      else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
      else { const ab = await new Blob([data]).arrayBuffer(); u8 = new Uint8Array(ab); }
      if (typeof position === 'number') { try { await fileWritable.seek(position); } catch(_) {} }
      await fileWritable.write(u8);
    }, async close() {}, async abort() {}
  }, { highWaterMark: 1 });
}

export async function remuxSessionToFile(sessionId, handle, opts={}) {
  const { Input, Output, WebMOutputFormat, StreamTarget, Conversion } = window.Mediabunny;
  const index = await buildSessionIndex(sessionId, opts.mimeType || 'video/webm', opts.onIndexProgress);
  const source = createStreamSourceForSession(index, { cacheMB: opts.cacheMB, prefetch: opts.prefetch, onByteProgress: opts.onByteProgress });
  const input = new Input({ source, formats: [window.Mediabunny.WEBM] });
  const writable = await handle.createWritable({ keepExistingData: false });
  try { await writable.truncate(0); } catch(_) {}
  const sink = wrapFileWritableAsSink(writable);
  const target = new StreamTarget(sink, { chunked: true, chunkSize: opts.chunkSize || (16*1024*1024) });
  const output = new Output({ format: new WebMOutputFormat(), target });
  const convOpts = { input, output };
  if (opts.forceAudio) convOpts.audio = { forceTranscode: true };
  if (opts.forceVideo) convOpts.video = { forceTranscode: true };
  const conversion = await Conversion.init(convOpts);
  conversion.onProgress = (p) => { opts.onProgress?.(Math.max(0, Math.min(1, p||0))); };
  await conversion.execute();
  if (opts.padMB && opts.padMB > 0) {
    const padChunk = new Uint8Array(16*1024*1024); let remaining = (opts.padMB|0)*1024*1024;
    while (remaining > 0) { const slice = remaining < padChunk.length ? padChunk.subarray(0, remaining) : padChunk; await writable.write(slice); remaining -= slice.length; }
  }
  await writable.close();
}

export async function remuxSessionToBlob(sessionId, opts={}) {
  const { Input, Output, WebMOutputFormat, BufferTarget, StreamSource, Conversion } = window.Mediabunny;
  const index = await buildSessionIndex(sessionId, opts.mimeType || 'video/webm', opts.onIndexProgress);
  const source = createStreamSourceForSession(index, { cacheMB: opts.cacheMB, prefetch: opts.prefetch, onByteProgress: opts.onByteProgress });
  const input = new Input({ source, formats: [window.Mediabunny.WEBM] });
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const convOpts = { input, output };
  if (opts.forceAudio) convOpts.audio = { forceTranscode: true };
  if (opts.forceVideo) convOpts.video = { forceTranscode: true };
  const conversion = await Conversion.init(convOpts);
  conversion.onProgress = (p) => { opts.onProgress?.(Math.max(0, Math.min(1, p||0))); };
  await conversion.execute();
  return new Blob([target.buffer], { type: index.mimeType });
}

export async function remuxIndexWindowToBlob(index, opts={}) {
  const { Input, Output, WebMOutputFormat, BufferTarget, Conversion } = window.Mediabunny;
  const source = createStreamSourceForSession(index, { cacheMB: opts.cacheMB, prefetch: opts.prefetch, onByteProgress: opts.onByteProgress });
  const input = new Input({ source, formats: [window.Mediabunny.WEBM] });
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const convOpts = { input, output, trim: { start: opts.startSec || 0, end: opts.endSec || undefined } };
  if (opts.forceAudio) convOpts.audio = { forceTranscode: true };
  if (opts.forceVideo) convOpts.video = { forceTranscode: true };
  const conversion = await Conversion.init(convOpts);
  conversion.onProgress = (p) => { opts.onProgress?.(Math.max(0, Math.min(1, p||0))); };
  await conversion.execute();
  return new Blob([target.buffer], { type: index.mimeType });
}

// Also expose a convenience to fetch sessions with sorting
export async function listSessionsSorted() {
  const s = await listSessions();
  s.sort((a,b)=> (b.startedAt||0) - (a.startedAt||0));
  return s;
}
