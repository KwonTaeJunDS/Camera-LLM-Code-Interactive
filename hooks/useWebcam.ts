import {useCallback, useEffect, useRef, useState} from 'react';

export type CameraStatus = 'requesting' | 'ready' | 'error';

function cameraError(error: unknown) {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera access is off. Allow the camera in your browser, then try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera found. Connect a webcam and try again.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is busy. Close other camera apps and try again.';
  }
  return 'Could not start the camera. Check your device and browser permissions.';
}

export function useWebcam() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('requesting');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let ownedStream: MediaStream | null = null;
    const video = videoRef.current;
    setStatus('requesting');
    setError(null);

    const fail = (message: string) => {
      if (cancelled) return;
      setStatus('error');
      setError(message);
    };
    const onEnded = () => fail('The camera disconnected. Reconnect it and try again.');
    const onCanPlay = () => {
      if (!cancelled && video && video.videoWidth > 0 && video.readyState >= 2 &&
          ownedStream?.getVideoTracks().some((track) => track.readyState === 'live')) {
        setStatus('ready');
        setError(null);
      }
    };
    video?.addEventListener('playing', onCanPlay);
    video?.addEventListener('loadeddata', onCanPlay);

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        fail('Camera access needs localhost or a secure connection. Open http://localhost:3000.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: {ideal: 1280}, height: {ideal: 720},
            aspectRatio: {ideal: 16 / 9}, frameRate: {ideal: 30, max: 30},
            facingMode: 'user',
          },
        });
        if (cancelled || !video) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        ownedStream = stream;
        streamRef.current = stream;
        stream.getVideoTracks().forEach((track) => track.addEventListener('ended', onEnded));
        video.srcObject = stream;
        await video.play();
        onCanPlay();
      } catch (cause) {
        if (ownedStream) {
          ownedStream.getTracks().forEach((track) => track.stop());
          if (streamRef.current === ownedStream) streamRef.current = null;
          if (video?.srcObject === ownedStream) video.srcObject = null;
        }
        fail(cameraError(cause));
      }
    }
    void start();

    return () => {
      cancelled = true;
      video?.removeEventListener('playing', onCanPlay);
      video?.removeEventListener('loadeddata', onCanPlay);
      ownedStream?.getTracks().forEach((track) => {
        track.removeEventListener('ended', onEnded);
        track.stop();
      });
      if (streamRef.current === ownedStream) streamRef.current = null;
      if (video?.srcObject === ownedStream) video.srcObject = null;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const takeSnapshot = useCallback(() => {
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!video || !track || track.readyState !== 'live' || video.readyState < 2 || video.videoWidth === 0) {
      throw new Error('The camera is not ready. Please reconnect and try again.');
    }
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not capture this frame.');
    // Match the mirrored view and mirrored hand coordinates, without stopping the stream.
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.86);
  }, []);

  return {videoRef, status, error, retry, takeSnapshot};
}
