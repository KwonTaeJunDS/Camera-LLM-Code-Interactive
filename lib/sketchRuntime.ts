import type {InteractionState} from './interaction';
import type {WorldId} from './worlds';

export const SKETCH_CHANNEL = 'live-parallel-worlds/sketch-v1';
export const SKETCH_LOAD_TIMEOUT_MS = 12_000;

const ERROR_MESSAGES = {
  runtime: 'This world could not run. Retry this frame.',
  source: 'This world could not start. Retry this frame.',
  canvas: 'This world did not create a canvas. Retry this frame.',
  timeout: 'This world took too long to start. Retry this frame.',
  resource: 'This sketch requested an unsupported resource. Retry this frame.',
  library: 'The local drawing engine could not load. Refresh the page.',
} as const;
type RuntimeFailure = keyof typeof ERROR_MESSAGES;

interface SketchIdentity {
  instanceId: string;
  worldId: WorldId;
  revision: number;
}

interface SketchDocumentOptions extends SketchIdentity {
  code: string;
  nonce: string;
  p5Url: string;
}

interface RuntimeConfiguration extends SketchDocumentOptions {
  channel: string;
  loadTimeout: number;
  errorMessages: typeof ERROR_MESSAGES;
}

type SketchMessage =
  | (SketchIdentity & {type: 'WORLD_READY'; channel: string})
  | (SketchIdentity & {type: 'WORLD_RUNTIME_ERROR'; channel: string; reason: RuntimeFailure; message: string});

/** Self-contained because this exact validator also executes inside srcDoc. */
export function normalizeInteractionPayload(value: unknown): InteractionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  for (const key of ['handX', 'handY', 'motion', 'motionVelocity']) {
    if (typeof state[key] !== 'number' || !Number.isFinite(state[key])) return null;
  }
  for (const key of ['handVisible', 'handOpen', 'pinch']) {
    if (typeof state[key] !== 'boolean') return null;
  }
  return {
    handX: Math.max(0, Math.min(1, state.handX as number)),
    handY: Math.max(0, Math.min(1, state.handY as number)),
    handVisible: state.handVisible as boolean,
    handOpen: state.handVisible === true && state.handOpen === true,
    pinch: state.handVisible === true && state.pinch === true,
    motion: state.handVisible ? Math.max(0, Math.min(1, state.motion as number)) : 0,
    motionVelocity: state.handVisible ? Math.max(0, Math.min(1, state.motionVelocity as number)) : 0,
  };
}

/** event.source must additionally be checked against the actual iframe window. */
export function readSketchMessage(value: unknown, identity: SketchIdentity): SketchMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.channel !== SKETCH_CHANNEL || data.instanceId !== identity.instanceId ||
      data.worldId !== identity.worldId || data.revision !== identity.revision) return null;
  if (data.type === 'WORLD_READY') return {...identity, channel: SKETCH_CHANNEL, type: 'WORLD_READY'};
  if (data.type === 'WORLD_RUNTIME_ERROR' && typeof data.reason === 'string' && Object.hasOwn(ERROR_MESSAGES, data.reason)) {
    const reason = data.reason as RuntimeFailure;
    // Never put an arbitrary generated exception or spoofed message in the UI.
    return {...identity, channel: SKETCH_CHANNEL, type: 'WORLD_RUNTIME_ERROR', reason, message: ERROR_MESSAGES[reason]};
  }
  return null;
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function htmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildSketchDocument(options: SketchDocumentOptions): string {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(options.nonce)) throw new Error('Invalid sketch nonce.');
  const asset = new URL(options.p5Url);
  if (!['http:', 'https:'].includes(asset.protocol) || asset.pathname !== '/vendor/p5.min.js' ||
      asset.search || asset.hash || asset.username || asset.password) {
    throw new Error('The sketch may only load the local p5.js vendor asset.');
  }
  const p5Url = asset.href;
  const config: RuntimeConfiguration = {...options, p5Url, channel: SKETCH_CHANNEL, loadTimeout: SKETCH_LOAD_TIMEOUT_MS, errorMessages: ERROR_MESSAGES};
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${options.nonce}' ${p5Url}`,
    "script-src-attr 'none'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  // Policies intersect: the first requires a nonce for inline JS. The second
  // prevents that nonce from authorizing external scripts on arbitrary hosts.
  const scriptNetworkPolicy = `script-src 'unsafe-inline' ${p5Url}; script-src-attr 'none'`;
  const bootstrap = `(${startSketchRuntime.toString()})(${inlineJson(config)}, ${normalizeInteractionPayload.toString()});`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${htmlAttribute(policy)}">
<meta http-equiv="Content-Security-Policy" content="${htmlAttribute(scriptNetworkPolicy)}">
<title>Interactive world</title>
<style>html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:#101111}canvas{display:block!important;width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important}#p5_loading{display:none}</style>
</head><body><script nonce="${options.nonce}">${bootstrap}</script></body></html>`;
}

/**
 * Runs in an opaque-origin iframe, never in the parent document. Keep this
 * function self-contained: toString() transports it without eval/unsafe-eval.
 * Sandboxing isolates DOM/storage/network privileges, not CPU execution. An
 * infinite synchronous loop in generated JS can still block a browser process.
 */
function startSketchRuntime(config: RuntimeConfiguration, validateInteraction: typeof normalizeInteractionPayload) {
  // p5's global-mode surface is intentionally dynamic; no p5 code runs in React.
  const scope = window as any;
  const sendToParent = window.parent.postMessage.bind(window.parent);
  const identity = {channel: config.channel, instanceId: config.instanceId, worldId: config.worldId, revision: config.revision};
  const neutral = {handX: 0.5, handY: 0.5, handVisible: false, handOpen: false, pinch: false, motion: 0, motionVelocity: 0};
  let hand = {...neutral};
  let pointer = {...neutral};
  let lastHandAt = 0;
  let lastPointerAt = 0;
  let pointerInside = false;
  let pointerDown = false;
  let virtualPinch = false;
  let failed = false;
  let ready = false;
  let instance: any = null;
  let parentHidden = document.hidden;
  let resumeAfterVisibility = true;
  let loadTimeout: ReturnType<typeof setTimeout>;
  let healthInterval: ReturnType<typeof setInterval>;
  let resizeFrame = 0;
  scope.interactionState = {...neutral};

  const sketch = () => instance || scope.p5?.instance;
  const fail = (reason: RuntimeFailure = 'runtime') => {
    if (failed) return;
    failed = true;
    clearTimeout(loadTimeout);
    clearInterval(healthInterval);
    try { sketch()?.noLoop(); } catch { /* The failing sketch may have damaged its own globals. */ }
    sendToParent({...identity, type: 'WORLD_RUNTIME_ERROR', reason, message: config.errorMessages[reason]}, '*');
  };
  const frameSize = () => ({
    width: Math.max(1, Math.min(960, Math.round(window.innerWidth))),
    height: Math.max(1, Math.min(960, Math.round(window.innerHeight))),
  });
  const synchronizeInput = () => {
    const now = performance.now();
    const tracked = hand.handVisible && now - lastHandAt < 700;
    const activePointer = pointerInside && !tracked;
    const input = tracked ? hand : activePointer ? {
      ...pointer,
      handVisible: true,
      handOpen: !pointerDown,
      pinch: pointerDown,
      motion: now - lastPointerAt < 180 ? pointer.motion : 0,
      motionVelocity: now - lastPointerAt < 180 ? pointer.motionVelocity : 0,
    } : {...neutral, handX: hand.handX, handY: hand.handY};
    Object.assign(scope.interactionState, input);
    const current = sketch();
    if (!current) return;
    const wasPinching = virtualPinch;
    virtualPinch = tracked && input.pinch;
    const mouseEvent = (name: string) => {
      if (typeof scope[name] !== 'function') return;
      const type = name === 'mousePressed' ? 'mousedown' : name === 'mouseReleased' ? 'mouseup' : name === 'mouseClicked' ? 'click' : 'mousemove';
      const event = new MouseEvent(type, {clientX: input.handX * current.width, clientY: input.handY * current.height, buttons: input.pinch ? 1 : 0});
      try { scope[name].call(scope, event); } catch { fail(); }
    };
    current._setProperty('mouseIsPressed', input.pinch);
    if (wasPinching && !virtualPinch) {
      mouseEvent('mouseReleased');
      if (tracked) mouseEvent('mouseClicked');
    }
    if (!tracked && !activePointer) return;
    const x = input.handX * current.width;
    const y = input.handY * current.height;
    const moved = x !== current.mouseX || y !== current.mouseY;
    // Preserve p5 mouse-based sketches while new sketches read interactionState.
    current._setProperty('pmouseX', current.mouseX);
    current._setProperty('pmouseY', current.mouseY);
    current._setProperty('mouseX', x);
    current._setProperty('mouseY', y);
    if (virtualPinch && !wasPinching) mouseEvent('mousePressed');
    if (tracked && moved) mouseEvent(virtualPinch ? 'mouseDragged' : 'mouseMoved');
  };
  const updateVisibility = (hidden: boolean) => {
    if (parentHidden === hidden) return;
    parentHidden = hidden;
    const current = sketch();
    if (!current?._setupDone) return;
    if (hidden) {
      resumeAfterVisibility = current.isLooping();
      current.noLoop();
    } else if (resumeAfterVisibility && !failed) {
      current.loop();
    }
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if (data.channel !== config.channel || data.instanceId !== config.instanceId ||
        data.worldId !== config.worldId || data.revision !== config.revision) return;
    if (data.type === 'HAND_STATE') {
      const normalized = validateInteraction(data.payload);
      if (!normalized) return;
      hand = normalized;
      lastHandAt = performance.now();
      synchronizeInput();
    } else if (data.type === 'WORLD_VISIBILITY' && typeof data.hidden === 'boolean') {
      updateVisibility(data.hidden);
    }
  });
  document.addEventListener('visibilitychange', () => updateVisibility(document.hidden));
  window.addEventListener('error', (event) => {
    fail();
    event.preventDefault();
  });
  window.addEventListener('unhandledrejection', (event) => {
    fail();
    event.preventDefault();
  });
  document.addEventListener('securitypolicyviolation', () => {
    fail('resource');
  });

  const updatePointer = (event: PointerEvent) => {
    const bounds = document.querySelector('canvas')?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    const now = performance.now();
    const velocity = Math.min(1, Math.hypot(x - pointer.handX, y - pointer.handY) * 100 / Math.max(16, now - lastPointerAt));
    pointer = {...pointer, handX: x, handY: y, motion: velocity, motionVelocity: velocity};
    pointerInside = true;
    lastPointerAt = now;
    synchronizeInput();
  };
  document.addEventListener('pointermove', updatePointer, {passive: true});
  document.addEventListener('pointerdown', (event) => {pointerDown = true; updatePointer(event);});
  document.addEventListener('pointerup', (event) => {pointerDown = false; updatePointer(event);});
  document.addEventListener('pointerleave', () => {pointerInside = false; pointerDown = false; synchronizeInput();});
  window.addEventListener('blur', () => {pointerInside = false; pointerDown = false; synchronizeInput();});

  const fitCanvas = () => {
    resizeFrame = 0;
    const current = sketch();
    if (!current?._setupDone || failed) return;
    const size = frameSize();
    try {
      if (current.width !== size.width || current.height !== size.height) {
        current.resizeCanvas(size.width, size.height, true);
        if (!current.isLooping() && !parentHidden) current.redraw();
      }
    } catch { fail(); }
  };
  window.addEventListener('resize', () => {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(fitCanvas);
  });
  const markReady = () => {
    if (failed || ready) return;
    const canvas = document.querySelector('canvas');
    if (!canvas || canvas.width < 1 || canvas.height < 1) {
      fail('canvas');
      return;
    }
    ready = true;
    clearTimeout(loadTimeout);
    sendToParent({...identity, type: 'WORLD_READY'}, '*');
  };

  const startP5 = () => {
    if (failed) return;
    try {
      const P5 = scope.p5;
      if (typeof P5 !== 'function') {fail('library'); return;}
      if (!config.code.trim()) {fail('source'); return;}
      P5.disableFriendlyErrors = true;
      const nativeCreateCanvas = P5.prototype.createCanvas;
      const nativeResizeCanvas = P5.prototype.resizeCanvas;
      const nativePixelDensity = P5.prototype.pixelDensity;
      const nativeFrameRate = P5.prototype.frameRate;
      P5.prototype.createCanvas = function (_width: unknown, _height: unknown, ...rest: unknown[]) {
        this._pixelDensity = 1;
        const size = frameSize();
        return nativeCreateCanvas.call(this, size.width, size.height, ...rest);
      };
      P5.prototype.resizeCanvas = function (_width: unknown, _height: unknown, ...rest: unknown[]) {
        this._pixelDensity = 1;
        const size = frameSize();
        return nativeResizeCanvas.call(this, size.width, size.height, ...rest);
      };
      P5.prototype.pixelDensity = function (density?: number) {
        return density === undefined ? nativePixelDensity.call(this) : nativePixelDensity.call(this, 1);
      };
      P5.prototype.frameRate = function (fps?: number) {
        return typeof fps === 'number' && Number.isFinite(fps)
          ? nativeFrameRate.call(this, Math.max(0, Math.min(30, fps)))
          : nativeFrameRate.call(this);
      };

      // Assigning textContent creates one script, so a literal HTML closing tag
      // in the generated source cannot escape into the iframe's HTML parser.
      const generatedScript = document.createElement('script');
      generatedScript.nonce = config.nonce;
      const globalCallbacks = ['setup', 'draw', 'preload', 'windowResized', 'mouseMoved', 'mouseDragged', 'mousePressed', 'mouseReleased', 'mouseClicked', 'doubleClicked', 'keyPressed', 'keyReleased', 'keyTyped', 'touchStarted', 'touchMoved', 'touchEnded'];
      generatedScript.textContent = config.code + '\n;' + globalCallbacks.map((name) =>
        `\nif (typeof ${name} === "function") window.${name} = ${name};`).join('');
      document.body.appendChild(generatedScript);
      if (failed) return;
      if (P5.instance) {fail('source'); return;}
      const userSetup = typeof scope.setup === 'function' ? scope.setup : null;
      const userDraw = typeof scope.draw === 'function' ? scope.draw : null;
      if (!userSetup && !userDraw) {
        fail('source');
        return;
      }
      scope.setup = () => {
        try {
          scope.frameRate(30);
          scope.pixelDensity(1);
          userSetup?.call(scope);
          if (parentHidden) {
            resumeAfterVisibility = sketch().isLooping();
            sketch().noLoop();
          }
          if (!userDraw) sketch().noLoop();
          if (!userDraw || parentHidden) markReady();
        } catch { fail(); }
      };
      scope.draw = () => {
        if (failed || parentHidden) return;
        try {
          synchronizeInput();
          userDraw?.call(scope);
          markReady();
        } catch { fail(); }
      };
      // p5's own global auto-init checks P5.instance. Construct once, after all
      // wrappers are installed; never call setup() directly a second time.
      instance = new P5();
      if (failed) return;
      healthInterval = setInterval(() => {
        if (failed || !ready || parentHidden) return;
        synchronizeInput();
        if (!document.querySelector('canvas')) fail('canvas');
      }, 500);
    } catch { fail(); }
  };

  loadTimeout = setTimeout(() => fail('timeout'), config.loadTimeout);
  const library = document.createElement('script');
  library.src = config.p5Url;
  library.onload = () => {
    // Let p5's load-time auto-init finish while setup/draw are still undefined.
    // Starting in the next task also avoids its misleading duplicate-import
    // warning when a script finishes before the iframe's window load event.
    if (document.readyState === 'complete') setTimeout(startP5, 0);
    else window.addEventListener('load', () => setTimeout(startP5, 0), {once: true});
  };
  library.onerror = () => fail('library');
  document.head.appendChild(library);
}
