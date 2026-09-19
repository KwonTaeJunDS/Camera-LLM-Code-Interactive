/// <reference types="vite/client" />
/**
 * MANUAL INTEGRATION TEST ONLY. This entry is never imported by index.tsx.
 * It replaces camera acquisition and /api requests only in this test document.
 * Home, all its hooks, MediaPipe, CodePreview, p5 and CSP are the real modules.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import Home from '../Home';
import CodePreview from '../components/CodePreview';
import { DEFAULT_INTERACTION, deriveInteractionState, type InteractionState } from '../lib/interaction';
import { WORLD_IDS, type WorldId, type WorldOutput } from '../lib/worlds';
import '../index.css';

type BatchKind = 'capture' | 'capture-again' | 'reimagine';
type Verdict = boolean | null;

interface BatchReport {
  number: number;
  kind: BatchKind;
  worlds: WorldId[];
  sameSnapshot: boolean;
  completions: string[];
}

interface FixtureReport {
  cameraStarts: number;
  cameraDisconnects: number;
  liveStreams: number;
  cameraFrame: number;
  videoMounts: number;
  videoTime: number;
  batchCount: number;
  captures: number;
  reimagines: number;
  totalRequests: number;
  retryRequests: number;
  abortedRequests: number;
  identicalBatchSnapshots: Verdict;
  newCaptureDiffers: Verdict;
  reimagineSame: Verdict;
  retrySame: Verdict;
  batches: BatchReport[];
}

let report: FixtureReport = {
  cameraStarts: 0, cameraDisconnects: 0, liveStreams: 0, cameraFrame: 0,
  videoMounts: 0, videoTime: 0, batchCount: 0, captures: 0, reimagines: 0,
  totalRequests: 0, retryRequests: 0, abortedRequests: 0,
  identicalBatchSnapshots: null, newCaptureDiffers: null, reimagineSame: null,
  retrySame: null, batches: [],
};
const subscribers = new Set<() => void>();
let disposed = false;

function publish(changes: Partial<FixtureReport>): void {
  if (disposed) return;
  report = { ...report, ...changes };
  subscribers.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function verdict(previous: Verdict, passed: boolean): boolean {
  return previous === false ? false : passed;
}

const liveStreams = new Set<MediaStream>();
const cameraTimers = new Map<MediaStream, number>();
let sourceFrame = 0;

function releaseSyntheticCamera(stream: MediaStream): void {
  const timer = cameraTimers.get(stream);
  if (timer !== undefined) window.clearInterval(timer);
  cameraTimers.delete(stream);
  liveStreams.delete(stream);
  publish({ liveStreams: liveStreams.size });
}

async function syntheticGetUserMedia(_constraints?: MediaStreamConstraints): Promise<MediaStream> {
  if (disposed) throw new DOMException('The test fixture has stopped.', 'AbortError');
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context || typeof canvas.captureStream !== 'function') {
    throw new DOMException('This test needs canvas.captureStream support.', 'NotSupportedError');
  }
  let cameraFrame = 0;
  const draw = () => {
    cameraFrame++;
    sourceFrame++;
    const phase = cameraFrame / 30;
    context.fillStyle = '#152735';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#355368';
    context.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 80) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, canvas.height); context.stroke();
    }
    for (let y = 0; y < canvas.height; y += 80) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(canvas.width, y); context.stroke();
    }
    context.fillStyle = '#eebc69';
    context.beginPath();
    context.arc(640 + Math.sin(phase * 0.7) * 350, 330 + Math.cos(phase) * 120, 95, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#9bddd2';
    context.lineWidth = 9;
    context.beginPath();
    for (let x = 0; x <= canvas.width; x += 8) {
      const y = 590 + Math.sin(x / 80 + phase * 2) * 36;
      if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.stroke();
    // Pre-mirrored labels become readable in the product's actual mirror view.
    context.save();
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.fillStyle = '#edf4ed';
    context.font = 'bold 30px monospace';
    context.fillText('SYNTHETIC CAMERA — NO REAL PERSON', 65, 74);
    context.font = '24px monospace';
    context.fillText(`FRAME ${String(sourceFrame).padStart(8, '0')} · 1280 × 720 · 30 FPS SOURCE`, 65, 117);
    context.fillText('LEFT', 65, 390);
    context.fillText('RIGHT', 1100, 390);
    context.restore();
  };
  draw();
  const stream = canvas.captureStream(30);
  liveStreams.add(stream);
  cameraTimers.set(stream, window.setInterval(() => {
    if (stream.getVideoTracks().every((track) => track.readyState === 'ended')) {
      releaseSyntheticCamera(stream);
      return;
    }
    draw();
  }, 1000 / 30));
  stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => releaseSyntheticCamera(stream), { once: true }));
  publish({ cameraStarts: report.cameraStarts + 1, liveStreams: liveStreams.size });
  return stream;
}

function disconnectCamera(): void {
  if (liveStreams.size === 0) return;
  for (const stream of [...liveStreams]) {
    for (const track of stream.getTracks()) {
      track.stop();
      // stop() alone intentionally does not dispatch ended in the browser.
      // Dispatch the event a hardware disconnection would deliver to useWebcam.
      track.dispatchEvent(new Event('ended'));
    }
    releaseSyntheticCamera(stream);
  }
  publish({ cameraDisconnects: report.cameraDisconnects + 1 });
}

const delays: Record<WorldId, number> = { particle: 350, physics: 900, abstract: 1400, organic: 2600 };

function sketchCode(id: WorldId, batch: number): string {
  const setup = `function setup() { createCanvas(windowWidth, windowHeight); pixelDensity(1); frameRate(30); }\n`;
  const input = `const h = window.interactionState || { handX: 0.5, handY: 0.5, handVisible: false, motion: 0 }; const t = frameCount / 30 + ${batch} * 0.3;`;
  if (id === 'physics') return setup + `function draw() {
    ${input}
    background(17, 35, 64); noFill(); stroke(80, 133, 193); strokeWeight(1.5);
    const x = h.handVisible ? h.handX * width : width / 2;
    const y = h.handVisible ? h.handY * height : height / 2;
    for (let i = 0; i < 5; i++) { ellipse(x, y, width * (0.22 + i * 0.15), height * (0.15 + i * 0.15)); }
    noStroke(); fill(255, 201, 114);
    circle(x + cos(t * 1.5) * width * 0.29, y + sin(t * 1.5) * height * 0.26, 24);
    fill(143, 194, 235); circle(x, y, 12);
  }`;
  if (id === 'particle') return setup + `function draw() {
    ${input}
    background(51, 18, 30); noStroke();
    const x = h.handVisible ? h.handX * width : width / 2;
    const y = h.handVisible ? h.handY * height : height / 2;
    for (let i = 0; i < 70; i++) {
      const a = i * 2.399 + t * (0.3 + (i % 5) * 0.09);
      const r = sqrt(i / 70) * min(width, height) * 0.5;
      fill(245, 102 + (i % 4) * 29, 85 + (i % 3) * 30, 200);
      circle(x + cos(a) * r, y + sin(a) * r, 3 + (i % 5));
    }
  }`;
  if (id === 'organic') return setup + `function draw() {
    ${input}
    background(14, 42, 30); strokeWeight(2);
    for (let i = 0; i < 7; i++) {
      const x = width * (0.13 + i * 0.12);
      const bend = sin(t + i) * width * 0.035 + (h.handVisible ? (h.handX - 0.5) * 35 : 0);
      stroke(108, 158, 85); noFill();
      bezier(x, height, x + bend, height * 0.66, x - bend, height * 0.4, x + bend, height * 0.13);
      for (let j = 0; j < 4; j++) {
        noStroke(); fill(100 + j * 20, 155 + j * 12, 106);
        ellipse(x + bend * (j / 4) + (j % 2 ? -10 : 10), height * (0.25 + j * 0.15), 24, 11);
      }
    }
  }`;
  return setup + `function draw() {
    ${input}
    background(40, 22, 58); push(); translate(width / 2, height / 2);
    rotate(sin(t * 0.45) * 0.3 + (h.handVisible ? h.handX * 0.4 : 0)); rectMode(CENTER); noFill();
    for (let i = 0; i < 10; i++) {
      stroke(133 + i * 10, 90 + i * 9, 215, 210); strokeWeight(2);
      rotate(0.14); rect(0, 0, width * (0.08 + i * 0.075), height * (0.08 + i * 0.075));
    }
    pop();
  }`;
}

interface PrivateBatch {
  number: number;
  kind: BatchKind;
  snapshot: string;
  worlds: Set<WorldId>;
  sameSnapshot: boolean;
  completions: string[];
}
let currentBatch: PrivateBatch | null = null;
let previousSnapshot = '';
let pendingOperation: BatchKind | 'retry' | null = null;
let organicAttempts = 0;
const cancelPendingResponses = new Set<() => void>();

function updateBatch(batch: PrivateBatch): void {
  const next: BatchReport = {
    number: batch.number, kind: batch.kind, worlds: [...batch.worlds],
    sameSnapshot: batch.sameSnapshot, completions: [...batch.completions],
  };
  const others = report.batches.filter((item) => item.number !== batch.number);
  publish({ batches: [...others, next].sort((a, b) => a.number - b.number).slice(-12) });
}

function registerRequest(image: string, worldId: WorldId): { batch: PrivateBatch; retry: boolean } {
  let retry = false;
  if (pendingOperation && pendingOperation !== 'retry' || !currentBatch) {
    const kind: BatchKind = pendingOperation && pendingOperation !== 'retry' ? pendingOperation : 'capture';
    const sameAsPrevious = image === previousSnapshot;
    currentBatch = {
      number: report.batchCount + 1, kind, snapshot: image,
      worlds: new Set(), sameSnapshot: true, completions: [],
    };
    publish({
      batchCount: report.batchCount + 1,
      captures: report.captures + (kind === 'reimagine' ? 0 : 1),
      reimagines: report.reimagines + (kind === 'reimagine' ? 1 : 0),
      reimagineSame: kind === 'reimagine' ? verdict(report.reimagineSame, sameAsPrevious) : report.reimagineSame,
      newCaptureDiffers: kind === 'capture-again' ? verdict(report.newCaptureDiffers, !sameAsPrevious) : report.newCaptureDiffers,
    });
    previousSnapshot = image;
    pendingOperation = null;
  } else if (pendingOperation === 'retry' || currentBatch.worlds.has(worldId)) {
    retry = true;
    pendingOperation = null;
  }
  const batch = currentBatch;
  if (retry) {
    publish({ retryRequests: report.retryRequests + 1, retrySame: verdict(report.retrySame, image === batch.snapshot) });
  } else {
    batch.worlds.add(worldId);
    batch.sameSnapshot &&= image === batch.snapshot;
    if (batch.worlds.size === 4) {
      publish({ identicalBatchSnapshots: verdict(report.identicalBatchSnapshots, batch.sameSnapshot) });
    }
  }
  publish({ totalRequests: report.totalRequests + 1 });
  updateBatch(batch);
  return { batch, retry };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const nativeFetch = window.fetch.bind(window);

async function fixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.origin !== window.location.origin || !['/api/health', '/api/generate'].includes(url.pathname)) {
    return nativeFetch(input, init);
  }
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (disposed || signal?.aborted) throw new DOMException('Simulated request cancelled.', 'AbortError');
  if (url.pathname === '/api/health') return jsonResponse({ configured: true, model: 'SIMULATED TEST' });

  const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return jsonResponse({ error: 'Invalid simulated test request.' }, 400); }
  if (!payload || typeof payload !== 'object' || !('imageBase64' in payload) || typeof payload.imageBase64 !== 'string'
    || !('worldId' in payload) || !WORLD_IDS.includes(payload.worldId as WorldId)) {
    return jsonResponse({ error: 'Invalid simulated test request.' }, 400);
  }
  const id = payload.worldId as WorldId;
  const { batch, retry } = registerRequest(payload.imageBase64, id);
  const failOrganic = id === 'organic' && ++organicAttempts === 1;

  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(): void {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      cancelPendingResponses.delete(abort);
    }
    function abort(): void {
      if (settled) return;
      settled = true;
      finish();
      batch.completions.push(`${id.toUpperCase()} ABORTED`);
      publish({ abortedRequests: report.abortedRequests + 1 });
      updateBatch(batch);
      reject(new DOMException('Simulated request cancelled.', 'AbortError'));
    }
    const timer = window.setTimeout(() => {
      if (settled) return;
      if (disposed || signal?.aborted) { abort(); return; }
      settled = true;
      finish();
      batch.completions.push(`${id.toUpperCase()}${failOrganic ? ' 503' : retry ? ' RETRY OK' : ' OK'}`);
      updateBatch(batch);
      if (failOrganic) {
        resolve(jsonResponse({ error: 'Simulated test failure (503). Retry this organic world.' }, 503));
      } else {
        const code = sketchCode(id, batch.number);
        resolve(jsonResponse({ code, fullResponse: `SIMULATED TEST ONLY — ${id.toUpperCase()} / BATCH ${batch.number}. No external generation or credentials used.` }));
      }
    }, retry ? 650 : delays[id]);
    cancelPendingResponses.add(abort);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || disposed) abort();
  });
}

function observeOperation(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target.closest('button') : null;
  if (!(target instanceof HTMLButtonElement) || target.disabled || !target.closest('#fixture-product')) return;
  if (target.getAttribute('aria-label') === 'Re-imagine the same snapshot') pendingOperation = 'reimagine';
  else if (/^Retry (physics|particle|organic|abstract) world$/.test(target.getAttribute('aria-label') ?? '')) pendingOperation = 'retry';
  else if (target.textContent?.includes('CAPTURE AGAIN')) pendingOperation = 'capture-again';
  else if (target.classList.contains('primary-button') && target.textContent?.includes('CAPTURE')) pendingOperation = 'capture';
}

function observeShortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || target?.isContentEditable
    || target?.closest('button, input, textarea, select, summary, a')) return;
  const product = document.getElementById('fixture-product');
  if (event.code === 'KeyR') {
    const button = product?.querySelector<HTMLButtonElement>('[aria-label="Re-imagine the same snapshot"]');
    if (button && !button.disabled) pendingOperation = 'reimagine';
  } else if (event.code === 'Space') {
    const button = [...(product?.querySelectorAll<HTMLButtonElement>('.capture-actions button') ?? [])]
      .find((item) => item.textContent?.includes('CAPTURE'));
    if (button && !button.disabled) pendingOperation = button.textContent?.includes('CAPTURE AGAIN') ? 'capture-again' : 'capture';
  }
}

function Result({ value, testId }: { value: Verdict; testId: string }) {
  return <output data-testid={testId} data-verdict={value === null ? 'pending' : value ? 'pass' : 'fail'}>
    {value === null ? 'NOT EXERCISED' : value ? 'PASS' : 'FAIL'}
  </output>;
}

function FixtureToolbar() {
  const value = useSyncExternalStore(subscribe, () => report);
  return <aside className="fixture-toolbar" aria-label="Visible integration test fixture">
    <strong>TEST FIXTURE — synthetic camera / simulated Gemini, no external generation</strong>
    <div>Actual Home, camera lifecycle, MediaPipe, iframe runtime and local p5.js. No real camera or personal image is used.</div>
    <div className="fixture-controls">
      <button id="fixture-disconnect-camera" type="button" disabled={value.liveStreams === 0} onClick={disconnectCamera}>Disconnect test camera</button>
      <button id="fixture-reset" type="button" onClick={() => window.location.replace(new URL('/tests/browser-fixture.html', window.location.origin).href)}>Reset fixture</button>
      <span>Responses: PARTICLE 350ms → PHYSICS 900ms → ABSTRACT 1400ms → ORGANIC 2600ms (503 once; retry succeeds)</span>
    </div>
    <div className="fixture-metrics">
      <span>Camera starts: <output data-testid="fixture-camera-starts">{value.cameraStarts}</output></span>
      <span>Live streams: <output data-testid="fixture-live-streams">{value.liveStreams}</output></span>
      <span>Video mounts: <output data-testid="fixture-video-mounts">{value.videoMounts}</output></span>
      <span>Source frame: <output data-testid="fixture-camera-frame">{value.cameraFrame}</output></span>
      <span>Video time: <output data-testid="fixture-video-time">{value.videoTime.toFixed(2)}s</output></span>
      <span>Batches: <output data-testid="fixture-batches">{value.batchCount}</output></span>
      <span>Captures: <output data-testid="fixture-captures">{value.captures}</output></span>
      <span>Re-imagines: <output data-testid="fixture-reimagines">{value.reimagines}</output></span>
      <span>Requests / retries / aborted: <output data-testid="fixture-requests">{value.totalRequests}</output> / <output data-testid="fixture-retries">{value.retryRequests}</output> / <output data-testid="fixture-aborts">{value.abortedRequests}</output></span>
    </div>
    <div className="fixture-metrics">
      <span>Same snapshot within each batch: <Result testId="fixture-identical-snapshots" value={value.identicalBatchSnapshots} /></span>
      <span>Capture again differs: <Result testId="fixture-new-capture-differs" value={value.newCaptureDiffers} /></span>
      <span>Re-imagine stays same: <Result testId="fixture-reimagine-same" value={value.reimagineSame} /></span>
      <span>Retry stays same: <Result testId="fixture-retry-same" value={value.retrySame} /></span>
    </div>
    <details open>
      <summary>Visible request history — snapshot bytes are never displayed or logged</summary>
      <ol>
        {value.batches.map((batch) => <li key={batch.number} data-testid={`fixture-batch-${batch.number}`} data-kind={batch.kind}>
          BATCH {batch.number} · {batch.kind.toUpperCase()} · {batch.worlds.length}/4 requests ·
          {' '}{batch.worlds.length < 4 ? 'snapshot comparison pending' : batch.sameSnapshot ? 'SAME SNAPSHOT: PASS' : 'SAME SNAPSHOT: FAIL'} ·
          {' '}{batch.completions.length ? batch.completions.join(' → ') : 'WAITING'}
        </li>)}
      </ol>
    </details>
  </aside>;
}

const probeCode = `
let lastFixtureInput = '';
function setup() { createCanvas(windowWidth, windowHeight); frameRate(30); textFont('monospace'); }
function draw() {
  const h = window.interactionState || { handX: 0.5, handY: 0.5, handVisible: false };
  background(15, 28, 34); stroke(42, 66, 72); strokeWeight(1);
  line(width * 0.5, 0, width * 0.5, height); line(0, height * 0.5, width, height * 0.5);
  noStroke(); fill(h.handVisible ? '#8ee2c6' : '#8397a4'); circle(h.handX * width, h.handY * height, 34);
  fill('#e0e8e5'); textSize(15); textAlign(LEFT, TOP);
  text('TEST-ONLY INPUT PROBE', 18, 16);
  text('handX=' + h.handX.toFixed(3) + '  handY=' + h.handY.toFixed(3) + '  visible=' + h.handVisible, 18, height - 34);
  const signature = [h.handX, h.handY, h.handVisible].join('|');
  if (signature !== lastFixtureInput) {
    lastFixtureInput = signature;
    window.parent.postMessage({ type: 'TEST_FIXTURE_INPUT_OBSERVED', handX: h.handX, handY: h.handY, handVisible: h.handVisible }, '*');
  }
}
`;

function RuntimeInputProbe() {
  const interactionRef = useRef<InteractionState>({ ...DEFAULT_INTERACTION });
  const frameBox = useRef<HTMLDivElement | null>(null);
  const [received, setReceived] = useState<{ handX: number; handY: number; handVisible: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const output = useMemo<WorldOutput>(() => ({
    id: 'abstract', status: 'success', code: probeCode, fullResponse: 'TEST ONLY', error: null, revision: 999,
  }), []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameBox.current?.querySelector('iframe')?.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'TEST_FIXTURE_INPUT_OBSERVED'
        || !('handX' in data) || typeof data.handX !== 'number' || !Number.isFinite(data.handX)
        || !('handY' in data) || typeof data.handY !== 'number' || !Number.isFinite(data.handY)
        || !('handVisible' in data) || typeof data.handVisible !== 'boolean') return;
      setReceived({ handX: data.handX, handY: data.handY, handVisible: data.handVisible });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const send = () => {
    const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    landmarks[8] = { x: 0.2, y: 0.3, z: 0 };
    interactionRef.current = deriveInteractionState(landmarks, DEFAULT_INTERACTION, performance.now(), null);
  };
  const passed = received?.handVisible === true && Math.abs(received.handX - 0.8) < 0.00001 && Math.abs(received.handY - 0.3) < 0.00001;
  return <section className="fixture-runtime" aria-label="Test-only runtime input verification">
    <h2>TEST ONLY — real CodePreview / postMessage input check</h2>
    <p>The button passes raw index x=0.2, y=0.3 through the actual normalization helper. Expect mirrored x=0.8, y=0.3 and a green circle in the upper right. This never changes the product camera or its hand state.</p>
    <div className="fixture-runtime-controls">
      <button id="fixture-send-hand" type="button" onClick={send}>Send mirrored hand input</button>
      <button id="fixture-clear-hand" type="button" onClick={() => { interactionRef.current = { ...DEFAULT_INTERACTION }; }}>Clear hand input</button>
    </div>
    <output data-testid="fixture-runtime-input" data-verdict={passed ? 'pass' : 'pending'}>
      {received ? `Sandbox observed: handX=${received.handX.toFixed(3)}, handY=${received.handY.toFixed(3)}, visible=${received.handVisible} — ${passed ? 'PASS' : 'waiting for mirrored input'}` : 'Waiting for the actual sandbox to report its input.'}
    </output>
    {error && <p className="fixture-runtime-error" role="alert">Actual runtime error: {error}</p>}
    <div className="fixture-runtime-box" ref={frameBox}>
      <CodePreview output={output} interactionRef={interactionRef} onRuntimeError={(_id, message) => setError(message)} />
    </div>
  </section>;
}

function FixtureApp() {
  return <>
    <FixtureToolbar />
    <div id="fixture-product"><Home /></div>
    <RuntimeInputProbe />
  </>;
}

const rootElement = document.getElementById('fixture-root')!;
const mediaDevices = navigator.mediaDevices;
const originalCameraDescriptor = mediaDevices ? Object.getOwnPropertyDescriptor(mediaDevices, 'getUserMedia') : undefined;
let root: ReturnType<typeof createRoot> | null = null;
let sampleTimer: number | undefined;
let videoObserver: MutationObserver | undefined;
const seenVideos = new WeakSet<HTMLVideoElement>();

function inspectVideo(): void {
  const video = document.querySelector<HTMLVideoElement>('#fixture-product .camera-video');
  if (video && !seenVideos.has(video)) {
    seenVideos.add(video);
    publish({ videoMounts: report.videoMounts + 1 });
  }
}

function cleanup(): void {
  if (disposed) return;
  document.removeEventListener('click', observeOperation, true);
  window.removeEventListener('keydown', observeShortcut, true);
  videoObserver?.disconnect();
  window.clearInterval(sampleTimer);
  for (const abort of [...cancelPendingResponses]) abort();
  root?.unmount();
  for (const stream of [...liveStreams]) {
    stream.getTracks().forEach((track) => track.stop());
    releaseSyntheticCamera(stream);
  }
  if (window.fetch === fixtureFetch) window.fetch = nativeFetch;
  if (mediaDevices?.getUserMedia === syntheticGetUserMedia) {
    if (originalCameraDescriptor) Object.defineProperty(mediaDevices, 'getUserMedia', originalCameraDescriptor);
    else Reflect.deleteProperty(mediaDevices, 'getUserMedia');
  }
  previousSnapshot = '';
  currentBatch = null;
  disposed = true;
}

try {
  if (window.location.pathname !== '/tests/browser-fixture.html') throw new Error('This fixture may only run at its explicit test route.');
  if (!mediaDevices) throw new Error('This fixture needs a secure localhost browser context.');
  // Both replacements are document-local and are installed before Home mounts.
  Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true, writable: true, value: syntheticGetUserMedia });
  window.fetch = fixtureFetch;
  document.addEventListener('click', observeOperation, true);
  window.addEventListener('keydown', observeShortcut, true);
  videoObserver = new MutationObserver(inspectVideo);
  videoObserver.observe(rootElement, { childList: true, subtree: true });
  sampleTimer = window.setInterval(() => {
    inspectVideo();
    const video = document.querySelector<HTMLVideoElement>('#fixture-product .camera-video');
    publish({ cameraFrame: sourceFrame, videoTime: video?.currentTime ?? 0, liveStreams: liveStreams.size });
  }, 500);
  root = createRoot(rootElement);
  root.render(<FixtureApp />);
  window.addEventListener('pagehide', cleanup, { once: true });
  import.meta.hot?.dispose(cleanup);
} catch (error) {
  cleanup();
  const message = document.createElement('pre');
  message.className = 'fixture-fatal';
  message.textContent = `TEST FIXTURE COULD NOT START\n${error instanceof Error ? error.message : 'Unknown local fixture error.'}\nNo real camera or generation request was started.`;
  rootElement.replaceChildren(message);
}
