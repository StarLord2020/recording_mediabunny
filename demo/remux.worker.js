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

  try {
    if (!self.Mediabunny) throw new Error('Mediabunny bundle not loaded in worker');

    const { Input, Output, WebMOutputFormat, BufferTarget, BlobSource, WEBM, Conversion } = self.Mediabunny;

    const t0 = (self.performance?.now?.() ?? Date.now());
    const fullBlob = new Blob(chunks, { type: mimeType });

    const input = new Input({ source: new BlobSource(fullBlob), formats: [WEBM] });
    const target = new BufferTarget();
    const output = new Output({ format: new WebMOutputFormat(), target });

    const conversion = await Conversion.init({ input, output });
    conversion.onProgress = (p) => {
      // Clamp and post progress
      const clamped = Math.max(0, Math.min(1, p || 0));
      self.postMessage({ type: 'progress', progress: clamped });
    };

    await conversion.execute();

    const buffer = target.buffer; // ArrayBuffer
    const t1 = (self.performance?.now?.() ?? Date.now());
    self.postMessage({ type: 'done', buffer, elapsedMs: t1 - t0 }, [buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};

