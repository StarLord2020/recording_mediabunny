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
    let ask = null;
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
      ask = (type, payload = {}, transfer = []) => new Promise((resolve, reject) => {
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
          // chunk is a StreamTargetChunk: { type: 'write', data: Uint8Array, position: number }
          const data = chunk && chunk.data ? chunk.data : chunk;
          const position = chunk && typeof chunk.position === 'number' ? chunk.position : undefined;
          let u8;
          if (data instanceof Uint8Array) {
            u8 = data;
          } else if (data?.buffer) {
            u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length || 0);
          } else if (data instanceof ArrayBuffer) {
            u8 = new Uint8Array(data);
          } else {
            const ab = await new Blob([data]).arrayBuffer();
            u8 = new Uint8Array(ab);
          }
          const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
          await ask('write', { data: ab, position }, [ab]);
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


    // Ensure the underlying file gets closed in stream mode
    if (mode === 'stream' && port && ask) {
      try { await ask('close'); } catch (_) {}
    }

    const t1 = (self.performance?.now?.() ?? Date.now());
    if (mode === 'stream' && port) {
      self.postMessage({ type: 'done', streamed: true, elapsedMs: t1 - t0 });
    } else {
      console.log(output.target, 'output.target');
      
      const buffer = output.target.buffer; // BufferTarget
      self.postMessage({ type: 'done', buffer, elapsedMs: t1 - t0 }, [buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
