// TEST ONLY: displays saved Gemini output with transparent setup/draw diagnostics.
// Source files stay untouched. This page never opens a camera or calls an API.
import {useCallback, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import WorldFrame from '../components/WorldFrame';
import {DEFAULT_INTERACTION, type InteractionState} from '../lib/interaction';
import {createWorlds, WORLD_IDS, type WorldId} from '../lib/worlds';
import '../index.css';

const DIAGNOSTIC_MARKER = 'LPW_TEST_ONLY_SKETCH_DIAGNOSTIC_V1';
type DiagnosticPhase = 'install' | 'setup' | 'draw';
type FixtureDiagnostic = {
  verification: string;
  status: string;
  sourceLength?: number;
  digest?: string;
  phase?: DiagnosticPhase;
  name?: string;
  message?: string;
};

// Self-contained: the same short-text sanitizer is sent into the test iframe.
function safeDiagnosticText(value: unknown): string {
  if (typeof value !== 'string') return 'Details unavailable';
  return value
    .replace(/\b(?:https?|file|data|blob|wss?|ftp):[^\s"'<>]*/gi, '[redacted URL]')
    .replace(/\bwww\.[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(?:[a-z]:[\\/]|\\\\)[^\s"'<>]+/gi, '[redacted path]')
    .replace(/\b(?:api[\s_-]*key|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '[redacted credential]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|[A-Za-z0-9_=-]{24,})\b/g, '[redacted token]')
    .replace(/[^\x20-\x7e]/g, ' ')
    .trim()
    .slice(0, 180) || 'Details unavailable';
}

function installTestDiagnostics(
  meta: {marker: string; worldId: WorldId; verification: string},
  originals: {setup: unknown; draw: unknown},
  sanitize: typeof safeDiagnosticText,
) {
  const scope = window as any;
  const post = window.parent.postMessage.bind(window.parent);
  const notify = (phase: DiagnosticPhase, status: 'ok' | 'error', error?: unknown) => {
    let name = '';
    let message = '';
    if (status === 'error') {
      try {
        const failure = error as {name?: unknown; message?: unknown};
        const allowedNames = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError', 'SecurityError', 'DOMException'];
        name = typeof failure?.name === 'string' && allowedNames.includes(failure.name) ? failure.name : 'Error';
        message = sanitize(failure?.message);
      } catch {name = 'Error'; message = 'Details unavailable';}
    }
    try {post({...meta, phase, status, name, message}, '*');} catch { /* Diagnostics cannot change sketch behavior. */ }
  };
  for (const phase of ['setup', 'draw'] as const) {
    const original = originals[phase];
    if (typeof original !== 'function') continue;
    let completed = false;
    let reported = false;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      try {
        const result = original.apply(this, args);
        if (!completed) {completed = true; notify(phase, 'ok');}
        return result;
      } catch (error) {
        if (!reported) {reported = true; notify(phase, 'error', error);}
        throw error; // The real runtime must still receive the original failure.
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(scope, phase);
    if (!descriptor || descriptor.configurable) {
      let callback = wrapped;
      Object.defineProperty(scope, phase, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: () => callback,
        set: (next) => {
          // CodePreview aliases lexical setup/draw to window after this suffix.
          // Ignore that one raw-original alias, but accept the production
          // runtime's subsequent wrapper and every other callback assignment.
          if (next !== original) callback = next;
        },
      });
    } else {
      // Global function declarations have writable window bindings. Updating
      // the binding also updates `draw`/`setup`, so aliasing preserves this wrap.
      scope[phase] = wrapped;
    }
  }
  notify('install', 'ok');
}

function instrumentSavedSketch(code: string, worldId: WorldId, verification: string): string {
  const metadata = JSON.stringify({marker: DIAGNOSTIC_MARKER, worldId, verification});
  return code + '\n;\n// TEST-ONLY DIAGNOSTICS: original source above is unchanged.\n' +
    `(${installTestDiagnostics.toString()})(${metadata}, {setup: typeof setup === "function" ? setup : window.setup, draw: typeof draw === "function" ? draw : window.draw}, ${safeDiagnosticText.toString()});`;
}

function GeneratedWorldsCheck() {
  const [worlds, setWorlds] = useState(() => createWorlds('loading', 1));
  const [diagnostics, setDiagnostics] = useState<Partial<Record<WorldId, FixtureDiagnostic>>>({});
  const verifications = useRef<Partial<Record<WorldId, string>>>({});
  const verificationSequence = useRef(0);
  const interactionRef = useRef<InteractionState>({...DEFAULT_INTERACTION});
  const [position, setPosition] = useState('Autonomous animation');
  const load = useCallback(async (id: WorldId, signal?: AbortSignal) => {
    const verification = `${Date.now()}-${++verificationSequence.current}`;
    verifications.current[id] = verification;
    setDiagnostics((current) => ({...current, [id]: {verification, status: 'Loading saved fixture'}}));
    try {
      // Fetch the raw fixture as text; never import generated JS in the parent.
      // This raw GET avoids Vite's ordinary JS transform/source-map response.
      // A unique query refreshes it when the smoke script overwrites the file.
      const response = await fetch(`/test-results/${id}.js?raw&verification=${verification}`, {signal, cache: 'no-store'});
      if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error('No saved result.');
      const code = await response.text();
      if (/^\s*(?:export\s+|import\s+)/.test(code)) throw new Error('Expected raw sketch text, not a module wrapper.');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
      const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
      if (signal?.aborted || verifications.current[id] !== verification) return;
      setDiagnostics((current) => ({...current, [id]: {verification, status: 'Fixture loaded; awaiting setup/draw', sourceLength: code.length, digest}}));
      setWorlds((current) => current.map((world) => world.id === id ? {...world, status: 'success', code: instrumentSavedSketch(code, id, verification), fullResponse: code, error: null, revision: world.revision + 1} : world));
    } catch {
      if (!signal?.aborted && verifications.current[id] === verification) {
        setDiagnostics((current) => ({...current, [id]: {verification, status: 'Saved fixture could not load'}}));
        setWorlds((current) => current.map((world) => world.id === id ? {...world, status: 'error', error: 'No saved Gemini result yet. Run the explicit smoke test first.'} : world));
      }
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    for (const id of WORLD_IDS) void load(id, controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    const receiveDiagnostic = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || data.marker !== DIAGNOSTIC_MARKER || !WORLD_IDS.includes(data.worldId)) return;
      const id = data.worldId as WorldId;
      if (data.verification !== verifications.current[id] || !['install', 'setup', 'draw'].includes(data.phase) || !['ok', 'error'].includes(data.status)) return;
      const frame = document.querySelector<HTMLIFrameElement>(`[data-world="${id}"] iframe`);
      if (!frame || event.source !== frame.contentWindow) return;
      setDiagnostics((current) => ({...current, [id]: {
        ...current[id], verification: data.verification, phase: data.phase,
        status: data.status === 'error' ? 'Caught original sketch error' : `${data.phase} completed`,
        name: data.status === 'error' ? safeDiagnosticText(data.name) : undefined,
        message: data.status === 'error' ? safeDiagnosticText(data.message) : undefined,
      }}));
    };
    window.addEventListener('message', receiveDiagnostic);
    return () => window.removeEventListener('message', receiveDiagnostic);
  }, []);
  const runtimeError = useCallback((id: WorldId, revision: number, message: string) => {
    setWorlds((current) => current.map((world) => world.id === id && world.revision === revision ? {...world, status: 'error', error: message} : world));
  }, []);
  const move = (x: number, pinch = false) => {
    interactionRef.current = {...DEFAULT_INTERACTION, handX: x, handY: .35, handVisible: true, handOpen: !pinch, pinch, motion: .6, motionVelocity: .6};
    setPosition(`Hand x=${x.toFixed(1)}, y=0.35${pinch ? ' · PINCH' : ''}`);
  };
  return <div className="app-shell">
    <header className="site-header"><strong>REAL GEMINI OUTPUT · SYNTHETIC TEST SCENE</strong><a className="debug-toggle" href="/">RETURN TO LIVE APP</a></header>
    <main>
      <section className="introduction"><div className="intro-overline">LOCAL VERIFICATION · NO NEW API CALLS</div><h1>One moment.<span>Four worlds.</span></h1><p>Saved Gemini sketches for the illustrated test scene. Test-only wrappers report setup/draw failures; source files remain unchanged.</p></section>
      <div className="worlds-stage">
        {worlds.map((world) => <WorldFrame key={world.id} world={world} interactionRef={interactionRef} onRetry={(id) => {void load(id);}} onRuntimeError={runtimeError} />)}
        <section className="live-portrait" aria-label="Synthetic test scene"><div className="camera-heading"><span className="eyebrow">SYNTHETIC SNAPSHOT</span></div><div className="camera-screen"><img src="/test-results/synthetic-scene.png" alt="Illustration of a person holding a coffee cup; no personal image" style={{width: '100%', height: '100%', objectFit: 'contain'}} /></div><div className="camera-foot"><span className="tracking-state">THE SAME IMAGE WAS SENT TO ALL FOUR WORLDS</span></div></section>
      </div>
      <section className="capture-controls"><p role="status">{position}</p><div className="capture-actions">
        <button className="secondary-button" type="button" onClick={() => move(.2)}>HAND LEFT</button>
        <button className="primary-button" type="button" onClick={() => move(.8)}>HAND RIGHT</button>
        <button className="secondary-button" type="button" onClick={() => move(.5, true)}>PINCH</button>
        <button className="secondary-button" type="button" onClick={() => {interactionRef.current = {...DEFAULT_INTERACTION}; setPosition('Autonomous animation');}}>RELEASE</button>
      </div></section>
      <section aria-label="Test-only runtime diagnostics" style={{maxWidth: 1000, margin: '24px auto', padding: 24, border: '1px solid #454940', borderRadius: 12}}>
        <h2 style={{fontSize: 16, margin: '0 0 8px'}}>TEST-ONLY RUNTIME DIAGNOSTICS</h2>
        <p style={{fontSize: 12, color: '#afb7a5'}}>Fresh local ?raw text fetch per load; source runs only inside the sandbox. Fingerprints identify the exact saved text. Exceptions are shortened and URLs or credential-like strings are redacted. No source files or API calls are modified.</p>
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 20}}>
          {WORLD_IDS.map((id) => {
            const diagnostic = diagnostics[id];
            return <output key={id} data-diagnostic-world={id} aria-live="polite" style={{display: 'grid', alignContent: 'start', gap: 6, fontSize: 12, overflowWrap: 'anywhere'}}>
              <strong>{id.toUpperCase()}</strong>
              <span>{diagnostic?.status ?? 'Awaiting fixture'}</span>
              {diagnostic?.sourceLength !== undefined && <span>{diagnostic.sourceLength} chars · SHA-256 {diagnostic.digest}</span>}
              <span>Verification {diagnostic?.verification ?? 'pending'}</span>
              {diagnostic?.message && <code style={{color: '#ffc6b0'}}>{diagnostic.phase}: {diagnostic.name}: {diagnostic.message}</code>}
            </output>;
          })}
        </div>
      </section>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<GeneratedWorldsCheck />);
