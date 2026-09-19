/*
 * Keep this a classic worker: MediaPipe's WASM loader uses importScripts.
 * Vite bundles the worker URL; setup:assets serves the pinned Vision IIFE and
 * WASM/model files locally. Camera frames never leave this worker/browser.
 */

/** @type {import('@mediapipe/tasks-vision').HandLandmarker | null} */
let landmarker = null;
let initializing = false;
let disposed = false;
const initializationController = new AbortController();

function localAsset(value) {
  const url = new URL(value, self.location.href);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/mediapipe/')) {
    throw new Error('Hand tracking assets must be served locally.');
  }
  return url.href;
}

async function initialize(message) {
  if (initializing || landmarker || disposed) return;
  initializing = true;
  try {
    importScripts(localAsset(message.bundleUrl));
    // @mediapipe/tasks-vision 1.0.1 exposes `Vision` in its IIFE bundle.
    const { FilesetResolver, HandLandmarker } = self.Vision;
    const [fileset, response] = await Promise.all([
      FilesetResolver.forVisionTasks(localAsset(message.wasmRoot)),
      fetch(localAsset(message.modelUrl), { signal: initializationController.signal }),
    ]);
    if (!response.ok) throw new Error('The local hand model is unavailable.');
    const modelAssetBuffer = new Uint8Array(await response.arrayBuffer());
    if (disposed) return;

    const options = {
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.55,
    };
    let created;
    try {
      created = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetBuffer, delegate: 'GPU' },
        canvas: new OffscreenCanvas(640, 360),
      });
    } catch (error) {
      if (disposed) return;
      // Some browsers expose OffscreenCanvas without a usable worker GPU.
      created = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetBuffer, delegate: 'CPU' },
        canvas: new OffscreenCanvas(640, 360),
      });
    }

    if (disposed) {
      created.close();
      return;
    }
    landmarker = created;
    self.postMessage({ type: 'READY' });
  } catch (error) {
    if (!disposed) self.postMessage({ type: 'ERROR', stage: 'initialize' });
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === 'INIT') {
    void initialize(message);
    return;
  }

  if (message?.type === 'DISPOSE') {
    disposed = true;
    initializationController.abort();
    try {
      landmarker?.close();
    } finally {
      landmarker = null;
      self.close();
    }
    return;
  }

  if (message?.type !== 'FRAME') return;
  const { bitmap, timestamp } = message;
  try {
    if (!landmarker || disposed || !Number.isFinite(timestamp)) {
      throw new Error('Hand tracker is not ready.');
    }
    const result = landmarker.detectForVideo(bitmap, timestamp);
    self.postMessage({
      type: 'RESULT',
      timestamp,
      landmarks: result.landmarks[0] ?? null,
    });
  } catch (error) {
    if (!disposed) self.postMessage({ type: 'ERROR', stage: 'inference' });
  } finally {
    // The transferred frame has a single owner and is closed after every run.
    bitmap?.close();
  }
};
