/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright 2025 Google LLC
 * Adapted from the original Image-to-Code experience.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {Camera, Code2, RotateCcw, Timer, X} from 'lucide-react';
import LivePortrait from './components/LivePortrait';
import WorldFrame from './components/WorldFrame';
import {useWebcam} from './hooks/useWebcam';
import {useHandTracking} from './hooks/useHandTracking';
import {useParallelWorlds} from './hooks/useParallelWorlds';
import {WORLD_META, type WorldId} from './lib/worlds';

export default function Home() {
  const camera = useWebcam();
  const tracking = useHandTracking(camera.videoRef, camera.status === 'ready');
  const {worlds, generate, retry, runtimeError, generating, readyCount, settled} = useParallelWorlds();
  const [snapshot, setSnapshot] = useState('');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownEnabled, setCountdownEnabled] = useState(true);
  const [flash, setFlash] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [debugWorld, setDebugWorld] = useState<WorldId>('physics');
  const [serverStatus, setServerStatus] = useState<{configured: boolean; model: string} | null>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureLockRef = useRef(false);
  const mountedRef = useRef(true);
  const busy = generating || countdown !== null || flash;
  const canCapture = camera.status === 'ready' && !busy;
  const hasSnapshot = Boolean(snapshot);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/health', {signal: controller.signal, cache: 'no-store'})
      .then((response) => response.ok ? response.json() : null)
      .then((result: unknown) => {
        if (!controller.signal.aborted && result && typeof result === 'object' && 'configured' in result && 'model' in result) {
          setServerStatus({configured: result.configured === true, model: String(result.model)});
        }
      }).catch(() => { /* Generation requests provide actionable server errors if needed. */ });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      captureLockRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (camera.status !== 'ready' && captureLockRef.current) {
      if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
      captureLockRef.current = false;
      setCountdown(null);
    }
  }, [camera.status]);

  const capture = useCallback(() => {
    if (!canCapture || captureLockRef.current) return;
    captureLockRef.current = true;
    setCaptureError(null);
    const finishCapture = () => {
      if (!mountedRef.current) return;
      setCountdown(null);
      try {
        const nextSnapshot = camera.takeSnapshot();
        setSnapshot(nextSnapshot);
        setFlash(true);
        generate(nextSnapshot);
        flashTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setFlash(false);
        }, 350);
      } catch (error) {
        setCaptureError(error instanceof Error ? error.message : 'Could not capture this moment. Please try again.');
      } finally {
        captureLockRef.current = false;
      }
    };
    if (!countdownEnabled) {
      finishCapture();
      return;
    }
    let remaining = 3;
    setCountdown(remaining);
    const tick = () => {
      if (!mountedRef.current || !captureLockRef.current) return;
      remaining -= 1;
      if (remaining === 0) finishCapture();
      else {
        setCountdown(remaining);
        captureTimerRef.current = setTimeout(tick, 1000);
      }
    };
    captureTimerRef.current = setTimeout(tick, 1000);
  }, [canCapture, countdownEnabled, camera.takeSnapshot, generate]);

  const reimagine = useCallback(() => {
    if (!snapshot || busy || captureLockRef.current) return;
    setCaptureError(null);
    generate(snapshot);
  }, [snapshot, busy, generate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || target?.isContentEditable ||
          target?.closest('button, input, textarea, select, summary, a')) return;
      if (event.code === 'Space' && canCapture) {
        event.preventDefault();
        capture();
      }
      if (event.code === 'KeyR' && hasSnapshot && !busy) reimagine();
      if (event.code === 'Escape') setDebug(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [capture, reimagine, canCapture, hasSnapshot, busy]);

  const selectedWorld = worlds.find((world) => world.id === debugWorld)!;
  const stageMessage = countdown !== null ? `Capture in ${countdown}`
    : generating ? `${readyCount} of 4 worlds ready.`
    : settled && readyCount === 4 ? 'All worlds ready.'
    : settled ? 'Retry the worlds that could not finish.'
    : camera.status === 'ready' ? 'Ready to capture.' : 'Waiting for the camera.';

  return (
    <div className="app-shell app-shell--minimal">
      <main className="workspace">
        {serverStatus?.configured === false && (
          <p className="service-note" role="status">Gemini is not configured on the local server. Your camera can still run; generation needs the existing .env.local configuration.</p>
        )}

        <div className={`worlds-stage ${hasSnapshot ? 'has-snapshot' : ''}`} aria-label="Four parallel worlds surrounding your live camera">
          {worlds.map((world) => (
            <WorldFrame key={world.id} world={world} interactionRef={tracking.interactionRef} onRetry={retry} onRuntimeError={runtimeError} />
          ))}
          <LivePortrait videoRef={camera.videoRef} cameraStatus={camera.status} cameraError={camera.error} retryCamera={camera.retry}
            countdown={countdown} flash={flash} snapshot={snapshot} interactionRef={tracking.interactionRef}
            trackingStatus={tracking.status} trackingError={tracking.error} retryTracking={tracking.retry} />
        </div>

        <section className="capture-controls" aria-label="Capture controls">
          <p className="sr-only" aria-live="polite">{stageMessage}</p>
          <div className="capture-actions">
            <button className="primary-button" type="button" onClick={capture} disabled={!canCapture} title="Capture (Space)" aria-keyshortcuts="Space">
              <Camera size={16} aria-hidden="true" />{hasSnapshot ? 'CAPTURE AGAIN' : 'CAPTURE'}
            </button>
            {hasSnapshot && (
              <button className="icon-button" type="button" onClick={reimagine} disabled={busy} aria-label="Re-imagine the same snapshot" title="Re-imagine (R)" aria-keyshortcuts="R">
                <RotateCcw size={16} className={generating ? 'spin' : ''} aria-hidden="true" />
              </button>
            )}
            <button className={`timer-button ${countdownEnabled ? 'is-active' : ''}`} type="button" onClick={() => setCountdownEnabled((value) => !value)}
              disabled={busy} aria-label="Three second countdown" aria-pressed={countdownEnabled} title={countdownEnabled ? '3-second countdown on' : 'Countdown off'}>
              <Timer size={16} aria-hidden="true" />
            </button>
          </div>
          <button className={`debug-toggle icon-button ${debug ? 'is-active' : ''}`} type="button" onClick={() => setDebug((value) => !value)}
            aria-label={debug ? 'Close debug panel' : 'Open debug panel'} title={debug ? 'Close debug panel' : 'Debug'} aria-expanded={debug} aria-controls="debug-panel">
            {debug ? <X size={16} aria-hidden="true" /> : <Code2 size={16} aria-hidden="true" />}
          </button>
          {captureError && <p className="capture-error" role="alert">{captureError}</p>}
        </section>

        {debug && (
          <section id="debug-panel" className="debug-panel" aria-label="World debug information">
            <div className="debug-header">
              <span>GENERATION / RUNTIME</span>
              <span>{serverStatus?.model || 'Local server'} · Camera: {camera.status} · Hands: {tracking.status}</span>
            </div>
            {tracking.error && <p className="debug-error">{tracking.error}</p>}
            <div className="debug-tabs">
              {worlds.map((world) => <button type="button" key={world.id} className={debugWorld === world.id ? 'is-active' : ''} onClick={() => setDebugWorld(world.id)}>{WORLD_META[world.id].label}<span>{world.status}</span></button>)}
            </div>
            {selectedWorld.error && <p className="debug-error">{selectedWorld.error}</p>}
            <details open><summary>Generated JavaScript</summary><pre>{selectedWorld.code || 'Capture a moment to generate this world.'}</pre></details>
            <details><summary>Scene interpretation & response</summary><pre>{selectedWorld.fullResponse || 'No response yet.'}</pre></details>
            <p className="debug-note">Snapshots stay in memory. Only a capture, re-imagine, or retry sends the saved image to Gemini. Hand tracking runs locally.</p>
          </section>
        )}
      </main>

    </div>
  );
}
