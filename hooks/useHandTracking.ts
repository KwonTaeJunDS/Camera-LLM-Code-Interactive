import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import {
  DEFAULT_INTERACTION,
  deriveInteractionState,
  type HandLandmark,
  type InteractionState,
} from '../lib/interaction';

type TrackingStatus = 'idle' | 'loading' | 'ready' | 'error';
type TrackingResult = readonly HandLandmark[] | null;

interface TrackingBackend {
  kind: 'worker' | 'main';
  detect(video: HTMLVideoElement, timestamp: number): TrackingResult | Promise<TrackingResult>;
  close(): void;
}

export interface HandTracking {
  interactionRef: MutableRefObject<InteractionState>;
  status: TrackingStatus;
  error: string | null;
  retry(): void;
}

const INFERENCE_INTERVAL = 1000 / 20;
const STALE_FRAME_MS = 350;
const MAX_FRAME_WIDTH = 640;
const MODEL_PATH = '/mediapipe/hand_landmarker.task';
const WASM_PATH = '/mediapipe/wasm';
const TRACKING_ERROR = 'Hand tracking is unavailable. Check the local model files and retry.';

function abortError(): DOMException {
  return new DOMException('Hand tracking was stopped.', 'AbortError');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function localUrl(path: string): string {
  return new URL(path, window.location.href).href;
}

function frameSize(video: HTMLVideoElement): { width: number; height: number } {
  const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
  return {
    width: Math.max(1, Math.round(video.videoWidth * scale)),
    height: Math.max(1, Math.round(video.videoHeight * scale)),
  };
}

/** At most one transferred bitmap may be waiting on the worker. */
function createWorkerBackend(signal: AbortSignal): Promise<TrackingBackend> {
  return new Promise((resolve, reject) => {
    // No `type: 'module'`: the pinned MediaPipe IIFE/WASM use importScripts.
    const worker = new Worker(new URL('../workers/handTracking.worker.js', import.meta.url));
    let ready = false;
    let closed = false;
    let pending: {
      timestamp: number;
      resolve(result: TrackingResult): void;
      reject(error: Error): void;
    } | null = null;
    let frameTimeout: number | undefined;
    const startupTimeout = window.setTimeout(() => close(new Error(TRACKING_ERROR)), 20_000);

    function close(reason: Error = abortError()): void {
      if (closed) return;
      closed = true;
      window.clearTimeout(startupTimeout);
      window.clearTimeout(frameTimeout);
      signal.removeEventListener('abort', onAbort);
      if (!ready) reject(reason);
      pending?.reject(reason);
      pending = null;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      try {
        worker.postMessage({ type: 'DISPOSE' });
      } catch {
        // A crashed worker may already have lost its message port.
      } finally {
        // Let the worker close its graph first; terminate even if WASM is stuck.
        window.setTimeout(() => worker.terminate(), 100);
      }
    }

    function onAbort(): void {
      close();
    }

    worker.onerror = (event) => {
      event.preventDefault();
      close(new Error(TRACKING_ERROR));
    };
    worker.onmessageerror = () => close(new Error(TRACKING_ERROR));
    worker.onmessage = (event: MessageEvent<{
      type: 'READY' | 'RESULT' | 'ERROR';
      timestamp?: number;
      landmarks?: TrackingResult;
    }>) => {
      const message = event.data;
      if (closed) return;
      if (message.type === 'ERROR') {
        close(new Error(TRACKING_ERROR));
        return;
      }
      if (message.type === 'RESULT') {
        if (!pending || pending.timestamp !== message.timestamp) return;
        window.clearTimeout(frameTimeout);
        const frame = pending;
        pending = null;
        frame.resolve(message.landmarks ?? null);
        return;
      }
      if (message.type !== 'READY' || ready) return;
      ready = true;
      window.clearTimeout(startupTimeout);
      resolve({
        kind: 'worker',
        async detect(video, timestamp) {
          assertActive(signal);
          if (closed) throw new Error(TRACKING_ERROR);
          const { width, height } = frameSize(video);
          const bitmap = await createImageBitmap(video, {
            resizeWidth: width,
            resizeHeight: height,
            resizeQuality: 'low',
          });
          if (closed || signal.aborted) {
            bitmap.close();
            throw abortError();
          }
          return new Promise<TrackingResult>((frameResolve, frameReject) => {
            if (pending) {
              bitmap.close();
              frameReject(new Error('A hand tracking frame is already in progress.'));
              return;
            }
            pending = { timestamp, resolve: frameResolve, reject: frameReject };
            frameTimeout = window.setTimeout(() => close(new Error(TRACKING_ERROR)), 3_000);
            try {
              worker.postMessage({ type: 'FRAME', bitmap, timestamp }, [bitmap]);
            } catch (error) {
              bitmap.close();
              close(new Error(TRACKING_ERROR));
            }
          });
        },
        close,
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      close();
      return;
    }
    try {
      worker.postMessage({
        type: 'INIT',
        bundleUrl: localUrl('/mediapipe/vision_bundle.js'),
        wasmRoot: localUrl(WASM_PATH),
        modelUrl: localUrl(MODEL_PATH),
      });
    } catch {
      close(new Error(TRACKING_ERROR));
    }
  });
}

/** Fallback for browsers without transferable frames or worker WebGL. */
async function createMainBackend(signal: AbortSignal): Promise<TrackingBackend> {
  const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
  assertActive(signal);
  const [fileset, response] = await Promise.all([
    FilesetResolver.forVisionTasks(localUrl(WASM_PATH)),
    fetch(localUrl(MODEL_PATH), { signal }),
  ]);
  if (!response.ok) throw new Error(TRACKING_ERROR);
  const modelAssetBuffer = new Uint8Array(await response.arrayBuffer());
  assertActive(signal);
  const options = {
    runningMode: 'VIDEO' as const,
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.55,
  };
  let model: HandLandmarker;
  try {
    model = await HandLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetBuffer, delegate: 'GPU' },
      canvas: document.createElement('canvas'),
    });
  } catch (error) {
    assertActive(signal);
    model = await HandLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetBuffer, delegate: 'CPU' },
      canvas: document.createElement('canvas'),
    });
  }
  if (signal.aborted) {
    model.close();
    throw abortError();
  }

  const input = document.createElement('canvas');
  const context = input.getContext('2d', { alpha: false });
  if (!context) {
    model.close();
    throw new Error(TRACKING_ERROR);
  }
  let closed = false;
  return {
    kind: 'main',
    detect(video, timestamp) {
      assertActive(signal);
      if (closed) throw abortError();
      const { width, height } = frameSize(video);
      if (input.width !== width || input.height !== height) {
        input.width = width;
        input.height = height;
      }
      context.drawImage(video, 0, 0, width, height);
      return model.detectForVideo(input, timestamp).landmarks[0] ?? null;
    },
    close() {
      if (closed) return;
      closed = true;
      model.close();
      input.width = 0;
      input.height = 0;
    },
  };
}

/** Reuses the live video; it never opens, replaces, or stops the camera stream. */
export function useHandTracking(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
): HandTracking {
  const interactionRef = useRef<InteractionState>({ ...DEFAULT_INTERACTION });
  const [state, setState] = useState<{ status: TrackingStatus; error: string | null }>({ status: 'idle', error: null });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    interactionRef.current = { ...DEFAULT_INTERACTION };
    if (!enabled) {
      setState({ status: 'idle', error: null });
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    let failed = false;
    let backend: TrackingBackend | null = null;
    let frameRequest = 0;
    let inFlight = false;
    let loading = false;
    let lastInferenceAt = -Infinity;
    let lastVideoTime = -1;
    let previousTimestamp: number | null = null;
    let trackingEpoch = 0;
    let observedVideo: HTMLVideoElement | null = null;
    let observedStream: MediaStream | null = null;
    let observedTracks: MediaStreamTrack[] = [];
    const videoEvents = ['pause', 'ended', 'emptied', 'error'] as const;

    function resetInteraction(): void {
      interactionRef.current = { ...DEFAULT_INTERACTION };
      previousTimestamp = null;
      trackingEpoch++;
    }

    function releaseVideo(): void {
      videoEvents.forEach((type) => observedVideo?.removeEventListener(type, resetInteraction));
      observedTracks.forEach((track) => track.removeEventListener('ended', resetInteraction));
      observedVideo = null;
      observedStream = null;
      observedTracks = [];
    }

    function observeVideo(video: HTMLVideoElement | null): void {
      const stream = typeof MediaStream !== 'undefined' && video?.srcObject instanceof MediaStream
        ? video.srcObject : null;
      if (observedVideo === video && observedStream === stream) return;
      releaseVideo();
      resetInteraction();
      lastVideoTime = -1;
      observedVideo = video;
      observedStream = stream;
      observedTracks = stream?.getVideoTracks() ?? [];
      videoEvents.forEach((type) => video?.addEventListener(type, resetInteraction));
      observedTracks.forEach((track) => track.addEventListener('ended', resetInteraction));
    }

    async function loadBackend(preferWorker: boolean): Promise<void> {
      if (loading || disposed) return;
      loading = true;
      setState({ status: 'loading', error: null });
      try {
        let created: TrackingBackend | undefined;
        if (preferWorker && typeof Worker !== 'undefined'
          && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
          try {
            created = await createWorkerBackend(controller.signal);
          } catch (error) {
            assertActive(controller.signal);
          }
        }
        created ??= await createMainBackend(controller.signal);
        if (disposed) {
          created.close();
          return;
        }
        backend = created;
        setState({ status: 'ready', error: null });
      } catch (error) {
        if (!disposed) {
          failed = true;
          resetInteraction();
          setState({ status: 'error', error: TRACKING_ERROR });
        }
      } finally {
        loading = false;
      }
    }

    async function infer(video: HTMLVideoElement, timestamp: number, activeBackend: TrackingBackend): Promise<void> {
      const epoch = trackingEpoch;
      inFlight = true;
      try {
        const landmarks = await activeBackend.detect(video, timestamp);
        if (disposed || epoch !== trackingEpoch || document.hidden
          || videoRef.current !== video || video.paused || video.ended
          || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        // Never apply a late worker result after the current input has gone stale.
        if (performance.now() - timestamp > STALE_FRAME_MS) {
          resetInteraction();
          return;
        }
        interactionRef.current = deriveInteractionState(
          landmarks, interactionRef.current, timestamp, previousTimestamp,
          video.videoWidth / video.videoHeight,
        );
        previousTimestamp = timestamp;
      } catch (error) {
        if (disposed || backend !== activeBackend) return;
        // Pausing/replacing the source can reject createImageBitmap. This is
        // a dropped input frame, not a reason to restart the inference engine.
        if (epoch !== trackingEpoch || document.hidden || video.paused || video.ended
          || videoRef.current !== video) return;
        resetInteraction();
        backend = null;
        activeBackend.close();
        if (activeBackend.kind === 'worker') {
          void loadBackend(false);
        } else {
          failed = true;
          setState({ status: 'error', error: TRACKING_ERROR });
        }
      } finally {
        inFlight = false;
      }
    }

    function tick(timestamp: number): void {
      if (disposed || failed) return;
      frameRequest = requestAnimationFrame(tick);
      const video = videoRef.current;
      observeVideo(video);
      if (document.hidden || !video || video.paused || video.ended
        || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        || video.videoWidth === 0 || video.videoHeight === 0
        || (observedTracks.length > 0 && observedTracks.every((track) => track.readyState === 'ended'))) {
        if (interactionRef.current.handVisible) resetInteraction();
        return;
      }
      if (!backend) return;
      if (timestamp - lastInferenceAt > STALE_FRAME_MS
        && (inFlight || video.currentTime === lastVideoTime)
        && interactionRef.current.handVisible) {
        resetInteraction();
      }
      if (video.currentTime === lastVideoTime) {
        return;
      }
      if (inFlight || timestamp - lastInferenceAt < INFERENCE_INTERVAL) return;
      lastVideoTime = video.currentTime;
      lastInferenceAt = timestamp;
      void infer(video, timestamp, backend);
    }

    document.addEventListener('visibilitychange', resetInteraction);
    void loadBackend(true);
    frameRequest = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      controller.abort();
      cancelAnimationFrame(frameRequest);
      document.removeEventListener('visibilitychange', resetInteraction);
      releaseVideo();
      resetInteraction();
      backend?.close();
      backend = null;
    };
  }, [enabled, videoRef, attempt]);

  return { interactionRef, status: state.status, error: state.error, retry };
}
