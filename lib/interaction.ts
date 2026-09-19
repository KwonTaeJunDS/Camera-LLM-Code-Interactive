/** Shared, normalized input consumed by all four p5.js worlds. */
export interface InteractionState {
  handX: number;
  handY: number;
  handVisible: boolean;
  handOpen: boolean;
  pinch: boolean;
  motion: number;
  motionVelocity: number;
}

export const DEFAULT_INTERACTION: Readonly<InteractionState> = Object.freeze({
  handX: 0.5,
  handY: 0.5,
  handVisible: false,
  handOpen: false,
  pinch: false,
  motion: 0,
  motionVelocity: 0,
});

/** Structurally compatible with a MediaPipe NormalizedLandmark. */
export interface HandLandmark {
  x: number;
  y: number;
  z?: number;
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function isValidLandmark(point: HandLandmark | undefined): point is HandLandmark {
  return Boolean(
    point && Number.isFinite(point.x) && Number.isFinite(point.y)
      && (point.z === undefined || Number.isFinite(point.z)),
  );
}

function distance(a: HandLandmark, b: HandLandmark, aspect: number): number {
  // MediaPipe x/z are measured relative to image width, y to image height.
  return Math.hypot(
    (a.x - b.x) * aspect,
    a.y - b.y,
    ((a.z ?? 0) - (b.z ?? 0)) * aspect,
  );
}

function isFingerExtended(
  landmarks: readonly HandLandmark[],
  base: number,
  aspect: number,
  wasOpen: boolean,
): boolean {
  const wrist = landmarks[0];
  const mcp = landmarks[base];
  const pip = landmarks[base + 1];
  const tip = landmarks[base + 3];
  const firstLength = distance(mcp, pip, aspect);
  const secondLength = distance(pip, tip, aspect);
  if (firstLength < 0.00001 || secondLength < 0.00001) return false;

  const cosine = (
    (mcp.x - pip.x) * (tip.x - pip.x) * aspect ** 2
    + (mcp.y - pip.y) * (tip.y - pip.y)
    + ((mcp.z ?? 0) - (pip.z ?? 0)) * ((tip.z ?? 0) - (pip.z ?? 0)) * aspect ** 2
  ) / (firstLength * secondLength);

  // Angle plus wrist distance works with rotated hands; it does not assume
  // fingers point upward. Slight hysteresis avoids a flickering open gesture.
  return cosine < (wasOpen ? -0.55 : -0.7)
    && distance(wrist, tip, aspect) > distance(wrist, pip, aspect) * (wasOpen ? 1.03 : 1.1);
}

/**
 * Convert one detected hand into mirrored, time-smoothed interaction values.
 * Timestamps are monotonic milliseconds. Reacquisition starts at the actual
 * fingertip with zero velocity, so a hand entering the frame causes no burst.
 */
export function deriveInteractionState(
  landmarks: readonly HandLandmark[] | null | undefined,
  previous: Readonly<InteractionState>,
  timestamp: number,
  previousTimestamp: number | null,
  imageAspectRatio = 16 / 9,
): InteractionState {
  if (!landmarks || landmarks.length < 21) {
    return { ...DEFAULT_INTERACTION };
  }
  for (let index = 0; index < 21; index++) {
    if (!isValidLandmark(landmarks[index])) return { ...DEFAULT_INTERACTION };
  }

  const aspect = Number.isFinite(imageAspectRatio) && imageAspectRatio > 0
    ? imageAspectRatio : 16 / 9;
  const tip = landmarks[8];
  const targetX = clamp01(1 - tip.x);
  const targetY = clamp01(tip.y);
  const elapsed = previousTimestamp === null ? 0 : timestamp - previousTimestamp;
  const continuous = previous.handVisible
    && Number.isFinite(timestamp)
    && Number.isFinite(elapsed) && elapsed > 0 && elapsed <= 350
    && Number.isFinite(previous.handX) && Number.isFinite(previous.handY);
  const dt = continuous ? Math.max(8, elapsed) : 0;
  const smoothing = continuous ? 1 - Math.exp(-dt / 65) : 1;
  const handX = clamp01(clamp01(previous.handX) + (targetX - clamp01(previous.handX)) * smoothing);
  const handY = clamp01(clamp01(previous.handY) + (targetY - clamp01(previous.handY)) * smoothing);

  // Normalize speed to roughly 1.5 frame widths per second, then ease noise.
  const speed = continuous
    ? clamp01(Math.hypot(handX - previous.handX, handY - previous.handY) / (dt / 1000) / 1.5)
    : 0;
  const velocitySmoothing = 1 - Math.exp(-dt / 90);
  const motion = continuous
    ? clamp01(clamp01(previous.motion) + (speed - clamp01(previous.motion)) * velocitySmoothing)
    : 0;

  const palmSize = Math.max(
    distance(landmarks[0], landmarks[9], aspect),
    distance(landmarks[5], landmarks[17], aspect),
  );
  const pinchRatio = palmSize > 0.00001
    ? distance(landmarks[4], landmarks[8], aspect) / palmSize : Infinity;
  const pinch = pinchRatio < (continuous && previous.pinch ? 0.4 : 0.28);
  const extendedFingers = palmSize > 0.00001
    ? [5, 9, 13, 17].filter((base) => isFingerExtended(
      landmarks, base, aspect, continuous && previous.handOpen,
    )).length
    : 0;

  return {
    handX,
    handY,
    handVisible: true,
    handOpen: !pinch && extendedFingers >= 3,
    pinch,
    motion,
    motionVelocity: motion,
  };
}
