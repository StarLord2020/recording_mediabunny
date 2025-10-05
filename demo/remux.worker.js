// Remux worker: runs Mediabunny remux off the main thread
// Tries local bundle first (for deployed public/), then dev path from demo/
try {
  importScripts('./mediabunny.umd.js');
} catch (e) {
  try {
    importScripts('../dist/mediabunny.umd.js');
  } catch (e2) {
    // Will fail later and report error back to main
  }
}

/* global Mediabunny */
self.onmessage = async (e) => {
  const data = e.data || {};
  const chunks = data.chunks || [];
  const mimeType = data.mimeType || 'video/webm';
  const mode = data.mode || 'buffer'; // 'buffer' | 'stream'
  const port = data.port || null; // MessagePort for stream mode

  try {
    if (!self.Mediabunny) throw new Error('Mediabunny bundle not loaded in worker');

    const { Input, Output, WebMOutputFormat, BufferTarget, BlobSource, WEBM, Conversion, StreamTarget } = self.Mediabunny;

    const t0 = (self.performance?.now?.() ?? Date.now());
    const fullBlob = new Blob(chunks, { type: mimeType });
    const input = new Input({ source: new BlobSource(fullBlob), formats: [WEBM] });

    let output;
    if (mode === 'stream' && port) {
      // Create a WritableStream that proxies writes to the main thread via MessagePort
      let msgId = 0;
      const pending = new Map();
      port.onmessage = (ev) => {
        const d = ev.data || {};
        if (d.type === 'ack' && pending.has(d.id)) {
          pending.get(d.id).resolve();
          pending.delete(d.id);
        } else if (d.type === 'nack' && pending.has(d.id)) {
          pending.get(d.id).reject(new Error(d.message || 'write failed'));
          pending.delete(d.id);
        }
      };
      const ask = (type, payload = {}, transfer = []) => new Promise((resolve, reject) => {
        const id = msgId++;
        pending.set(id, { resolve, reject });
        try {
          port.postMessage({ type, id, ...payload }, transfer);
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });

      const writable = new WritableStream({
        async write(chunk) {
          let u8;
          if (chunk instanceof Uint8Array) {
            u8 = chunk;
          } else if (chunk?.buffer) {
            u8 = new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength || chunk.length || 0);
          } else if (chunk instanceof ArrayBuffer) {
            u8 = new Uint8Array(chunk);
          } else {
            // Try to coerce via Blob
            const ab = await new Blob([chunk]).arrayBuffer();
            u8 = new Uint8Array(ab);
          }
          // Transfer underlying buffer to avoid copies
          const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
          await ask('write', { data: ab }, [ab]);
        },
        async close() { await ask('close'); },
        async abort(reason) { await ask('abort', { message: String(reason || '') }); }
      }, { highWaterMark: 1 });

      const target = new StreamTarget(writable, { chunked: true, chunkSize: 16 * 1024 * 1024 });
      output = new Output({ format: new WebMOutputFormat(), target });
    } else {
      const target = new BufferTarget();
      output = new Output({ format: new WebMOutputFormat(), target });
    }

    const conversion = await Conversion.init({ input, output });
    conversion.onProgress = (p) => {
      const clamped = Math.max(0, Math.min(1, p || 0));
      self.postMessage({ type: 'progress', progress: clamped });
    };
    await conversion.execute();

    const t1 = (self.performance?.now?.() ?? Date.now());
    if (mode === 'stream' && port) {
      self.postMessage({ type: 'done', streamed: true, elapsedMs: t1 - t0 });
    } else {
      const buffer = output.target.buffer; // BufferTarget
      self.postMessage({ type: 'done', buffer, elapsedMs: t1 - t0 }, [buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
