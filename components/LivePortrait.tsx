import {useEffect, useRef, type MutableRefObject, type RefObject} from 'react';
import type {CameraStatus} from '../hooks/useWebcam';
import type {InteractionState} from '../lib/interaction';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  cameraStatus: CameraStatus;
  cameraError: string | null;
  retryCamera: () => void;
  countdown: number | null;
  flash: boolean;
  snapshot: string;
  interactionRef: MutableRefObject<InteractionState>;
  trackingStatus: 'idle' | 'loading' | 'ready' | 'error';
  trackingError: string | null;
  retryTracking: () => void;
}

export default function LivePortrait({videoRef, cameraStatus, cameraError, retryCamera, countdown, flash, snapshot, interactionRef, trackingStatus, trackingError, retryTracking}: Props) {
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const handLabelRef = useRef<HTMLSpanElement | null>(null);
  const lastLabel = useRef('SHOW YOUR HAND');

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const state = interactionRef.current;
      const video = videoRef.current;
      const cursor = cursorRef.current;
      if (cursor && video && video.videoWidth && video.videoHeight) {
        // The video uses object-fit: contain; account for letterboxing when the camera is not 16:9.
        const scale = Math.min(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight);
        const width = video.videoWidth * scale;
        const height = video.videoHeight * scale;
        cursor.style.left = `${(video.clientWidth - width) / 2 + state.handX * width}px`;
        cursor.style.top = `${(video.clientHeight - height) / 2 + state.handY * height}px`;
        cursor.style.opacity = state.handVisible && cameraStatus === 'ready' ? '1' : '0';
        cursor.dataset.pinch = String(state.pinch);
      }
      const label = state.handVisible ? (state.pinch ? 'PINCH DETECTED' : state.handOpen ? 'OPEN HAND' : 'HAND CONNECTED') : 'SHOW YOUR HAND';
      if (handLabelRef.current && label !== lastLabel.current) {
        handLabelRef.current.textContent = label;
        lastLabel.current = label;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [interactionRef, videoRef, cameraStatus]);

  return (
    <section className="live-portrait" aria-label="Live camera">
      <div className={`camera-screen ${cameraStatus === 'ready' ? 'camera-screen--ready' : ''}`}>
        {/* This element stays mounted through captures, requests, re-imagines, and retries. */}
        <video ref={videoRef} autoPlay muted playsInline className="camera-video" aria-label="Mirrored live webcam" />
        {cameraStatus !== 'ready' && (
          <div className="camera-empty">
            <p role="status">{cameraStatus === 'requesting' ? 'Allow camera access.' : cameraError}</p>
            {cameraStatus === 'error' && <button className="camera-retry" type="button" onClick={retryCamera} aria-label="Retry camera">RETRY CAMERA</button>}
            {cameraStatus === 'requesting' && <i className="tiny-loader" aria-hidden="true" />}
          </div>
        )}
        <div ref={cursorRef} className="hand-cursor" aria-hidden="true"><i /></div>
        {cameraStatus === 'ready' && trackingStatus === 'ready' && (
          <span className="sr-only" ref={handLabelRef}>SHOW YOUR HAND</span>
        )}
        {cameraStatus === 'ready' && trackingStatus !== 'ready' && (
          <div className="camera-status">
            {trackingStatus === 'error' ? (
              <button className="tracking-retry" type="button" onClick={retryTracking} aria-label="Retry hand tracking" title={trackingError || 'Retry local hand tracking'}>RETRY HANDS</button>
            ) : (
              <span className="tracking-state" role="status"><i className="tiny-loader" aria-hidden="true" /><span className="sr-only">Loading hand tracking.</span></span>
            )}
          </div>
        )}
        {countdown !== null && <div className="countdown" role="status" aria-label={`Capture in ${countdown}`}><span key={countdown}>{countdown}</span></div>}
        {flash && <div className="capture-flash" aria-hidden="true">{snapshot && <img src={snapshot} alt="" />}</div>}
      </div>
    </section>
  );
}
