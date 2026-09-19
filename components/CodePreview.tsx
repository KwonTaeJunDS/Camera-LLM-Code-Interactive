/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2025 Google LLC
 *
 * Retains the original image-to-code iframe/srcDoc preview architecture.
 */
import {useEffect, useMemo, useRef, useState, type MutableRefObject} from 'react';
import type {InteractionState} from '../lib/interaction';
import type {WorldId, WorldOutput} from '../lib/worlds';
import {
  buildSketchDocument,
  normalizeInteractionPayload,
  readSketchMessage,
  SKETCH_CHANNEL,
  SKETCH_LOAD_TIMEOUT_MS,
} from '../lib/sketchRuntime';

interface CodePreviewProps {
  output: WorldOutput;
  interactionRef: MutableRefObject<InteractionState>;
  onRuntimeError?: (id: WorldId, message: string) => void;
}

type PreviewState = {instanceId: string; status: 'loading' | 'ready' | 'error'; message?: string};

export default function CodePreview({output, interactionRef, onRuntimeError}: CodePreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const errorCallbackRef = useRef(onRuntimeError);
  const [preview, setPreview] = useState<PreviewState>({instanceId: '', status: 'loading'});
  const {id, code, revision} = output;

  // A tracking update only mutates a ref. The document changes on a new sketch,
  // edited code, or explicit retry; it never changes on a hand-tracking frame.
  const runtime = useMemo(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    const nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const instanceId = `${id}-${revision}-${nonce}`;
    return {
      instanceId,
      document: buildSketchDocument({
        code,
        worldId: id,
        revision,
        instanceId,
        nonce,
        p5Url: new URL('/vendor/p5.min.js', window.location.origin).href,
      }),
    };
  }, [id, code, revision]);

  useEffect(() => {
    errorCallbackRef.current = onRuntimeError;
  }, [onRuntimeError]);

  useEffect(() => {
    let failed = false;
    let ready = false;
    const frame = iframeRef.current;
    const envelope = {channel: SKETCH_CHANNEL, instanceId: runtime.instanceId, worldId: id, revision};
    setPreview({instanceId: runtime.instanceId, status: 'loading'});

    const fail = (message: string) => {
      if (failed) return;
      failed = true;
      window.clearTimeout(loadTimeout);
      setPreview({instanceId: runtime.instanceId, status: 'error', message});
      errorCallbackRef.current?.(id, message);
    };
    const sendVisibility = () => {
      // Opaque sandbox origins require '*'; the child checks event.source and
      // this per-execution correlation id before accepting a message.
      frame?.contentWindow?.postMessage({...envelope, type: 'WORLD_VISIBILITY', hidden: document.hidden}, '*');
    };
    const sendHandState = () => {
      if (document.hidden || failed || !ready) return;
      const payload = normalizeInteractionPayload(interactionRef.current);
      if (payload) frame?.contentWindow?.postMessage({...envelope, type: 'HAND_STATE', payload}, '*');
    };
    const receiveMessage = (event: MessageEvent) => {
      if (event.source !== frame?.contentWindow) return;
      const message = readSketchMessage(event.data, envelope);
      if (!message || failed) return;
      if (message.type === 'WORLD_RUNTIME_ERROR') {
        fail(message.message);
      } else {
        ready = true;
        window.clearTimeout(loadTimeout);
        setPreview({instanceId: runtime.instanceId, status: 'ready'});
        sendVisibility();
        sendHandState();
      }
    };
    const loadTimeout = window.setTimeout(() => {
      fail('This world could not start. Retry this frame.');
    }, SKETCH_LOAD_TIMEOUT_MS + 1_000);

    window.addEventListener('message', receiveMessage);
    document.addEventListener('visibilitychange', sendVisibility);
    const interval = window.setInterval(sendHandState, 40);
    sendVisibility();
    return () => {
      window.clearTimeout(loadTimeout);
      window.clearInterval(interval);
      window.removeEventListener('message', receiveMessage);
      document.removeEventListener('visibilitychange', sendVisibility);
    };
  }, [runtime, id, revision, interactionRef]);

  const current = preview.instanceId === runtime.instanceId ? preview : {status: 'loading' as const};
  return (
    <div
      className="sketch-preview"
      data-runtime-status={current.status}
      style={{position: 'relative', width: '100%', height: '100%', overflow: 'hidden'}}
    >
      <iframe
        ref={iframeRef}
        className="sketch-preview__iframe"
        srcDoc={runtime.document}
        title={`${id.toUpperCase()} — interactive p5.js world`}
        sandbox="allow-scripts"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'"
        referrerPolicy="no-referrer"
        tabIndex={-1}
        style={{display: 'block', width: '100%', height: '100%', border: 0, background: '#101111'}}
      />
      {current.status !== 'ready' && (
        <div
          className="sketch-preview__status"
          role={current.status === 'error' ? 'alert' : 'status'}
          style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 20, background: '#101111', color: '#a8aba4', fontSize: 12, textAlign: 'center', pointerEvents: 'none'}}
        >
          {current.status === 'error' && 'message' in current ? current.message : <><i className="tiny-loader" aria-hidden="true" /><span className="sr-only">Starting world</span></>}
        </div>
      )}
    </div>
  );
}
