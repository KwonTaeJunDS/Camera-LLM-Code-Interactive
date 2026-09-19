import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_INTERACTION,
  clamp01,
  deriveInteractionState,
  type HandLandmark,
} from '../lib/interaction.ts';

/** A geometric palm with four straight fingers, independent of camera data. */
function openPalm(): HandLandmark[] {
  const points: HandLandmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.7, z: 0 }));
  points[0] = { x: 0.5, y: 0.82, z: 0 };
  points[1] = { x: 0.4, y: 0.75, z: 0 };
  points[2] = { x: 0.34, y: 0.68, z: 0 };
  points[3] = { x: 0.28, y: 0.61, z: 0 };
  points[4] = { x: 0.22, y: 0.55, z: 0 };
  for (const [base, x, y] of [[5, 0.4, 0.56], [9, 0.49, 0.52], [13, 0.58, 0.55], [17, 0.66, 0.61]]) {
    for (let index = 0; index < 4; index++) {
      points[base + index] = { x, y: y - index * 0.095, z: 0 };
    }
  }
  return points;
}

function move(points: HandLandmark[], dx: number, dy: number): HandLandmark[] {
  return points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
}

function scale(points: HandLandmark[], factor: number): HandLandmark[] {
  return points.map((point) => ({
    x: 0.5 + (point.x - 0.5) * factor,
    y: 0.5 + (point.y - 0.5) * factor,
    z: (point.z ?? 0) * factor,
  }));
}

test('neutral input is immutable and contains no active gesture', () => {
  assert.ok(Object.isFrozen(DEFAULT_INTERACTION));
  assert.deepEqual(DEFAULT_INTERACTION, {
    handX: 0.5, handY: 0.5, handVisible: false,
    handOpen: false, pinch: false, motion: 0, motionVelocity: 0,
  });
});

test('index fingertip mirrors horizontally and starts without motion', () => {
  const points = openPalm();
  points[8] = { x: 0.2, y: 0.35, z: 0 };
  const result = deriveInteractionState(points, DEFAULT_INTERACTION, 100, null);
  assert.equal(result.handX, 0.8);
  assert.equal(result.handY, 0.35);
  assert.equal(result.handVisible, true);
  assert.equal(result.motion, 0);
  assert.equal(result.motionVelocity, 0);
});

test('a lost or malformed hand immediately releases all gestures', () => {
  const pinching = openPalm();
  pinching[4] = { ...pinching[8] };
  const previous = { ...deriveInteractionState(pinching, DEFAULT_INTERACTION, 100, null), motion: 0.7, motionVelocity: 0.7 };
  const invalid = openPalm();
  invalid[8].x = NaN;
  const sparse = new Array<HandLandmark>(21);
  sparse[8] = { x: 0.4, y: 0.5 };
  for (const input of [null, undefined, [], openPalm().slice(0, 9), invalid, sparse]) {
    const result = deriveInteractionState(input, previous, 150, 100);
    assert.deepEqual(result, DEFAULT_INTERACTION);
    assert.notEqual(result, DEFAULT_INTERACTION);
  }
});

test('coordinates stay in range even when fingertips leave the camera border', () => {
  const points = openPalm();
  points[8] = { x: -0.2, y: 1.3 };
  const result = deriveInteractionState(points, DEFAULT_INTERACTION, 100, null);
  assert.equal(result.handX, 1);
  assert.equal(result.handY, 1);
  assert.equal(clamp01(Infinity), 0);
  assert.equal(clamp01(NaN), 0);
  assert.equal(clamp01(-0.1), 0);
});

test('cursor smoothing follows the mirrored direction without jumping to the target', () => {
  const first = deriveInteractionState(openPalm(), DEFAULT_INTERACTION, 100, null);
  const shifted = move(openPalm(), -0.2, 0.1);
  const next = deriveInteractionState(shifted, first, 150, 100);
  assert.ok(next.handX > first.handX && next.handX < first.handX + 0.2);
  assert.ok(next.handY > first.handY && next.handY < first.handY + 0.1);
  assert.ok(next.motion > 0 && next.motion <= 1);
  assert.equal(next.motionVelocity, next.motion);
});

test('an open hand remains open after scaling or rotation of its image', () => {
  const points = openPalm();
  const angle = Math.PI * 0.65;
  const rotated = points.map(({ x, y, z }) => ({
    x: 0.5 + (x - 0.5) * Math.cos(angle) - (y - 0.5) * Math.sin(angle),
    y: 0.5 + (x - 0.5) * Math.sin(angle) + (y - 0.5) * Math.cos(angle),
    z,
  }));
  for (const input of [points, scale(points, 0.35), scale(points, 1.4), rotated]) {
    const result = deriveInteractionState(input, DEFAULT_INTERACTION, 100, null, 1);
    assert.equal(result.handOpen, true);
    assert.equal(result.pinch, false);
  }
});

test('folded fingers and a two-finger pose are not an open palm', () => {
  const fist = openPalm();
  for (const base of [5, 9, 13, 17]) {
    fist[base + 2] = { x: fist[base].x, y: fist[base + 1].y + 0.05, z: 0 };
    fist[base + 3] = { x: fist[base].x, y: fist[base].y + 0.09, z: 0 };
  }
  const peace = openPalm();
  for (const base of [13, 17]) peace[base + 3] = { ...fist[base + 3] };
  assert.equal(deriveInteractionState(fist, DEFAULT_INTERACTION, 100, null).handOpen, false);
  assert.equal(deriveInteractionState(peace, DEFAULT_INTERACTION, 100, null).handOpen, false);
});

test('pinch uses palm scale rather than a fixed screen distance', () => {
  const pinching = openPalm();
  pinching[4] = { x: pinching[8].x + 0.018, y: pinching[8].y + 0.018, z: 0 };
  for (const factor of [0.25, 0.5, 1, 1.6]) {
    const result = deriveInteractionState(scale(pinching, factor), DEFAULT_INTERACTION, 100, null);
    assert.equal(result.pinch, true);
    assert.equal(result.handOpen, false);
  }
});

test('pinch hysteresis holds near its boundary and releases when fingers separate', () => {
  const pinching = openPalm();
  pinching[4] = { ...pinching[8] };
  const first = deriveInteractionState(pinching, DEFAULT_INTERACTION, 100, null, 1);
  const nearBoundary = openPalm();
  const palmSize = 0.3;
  nearBoundary[4] = { x: nearBoundary[8].x + palmSize * 0.34, y: nearBoundary[8].y, z: 0 };
  const held = deriveInteractionState(nearBoundary, first, 150, 100, 1);
  const newlyEntered = deriveInteractionState(nearBoundary, DEFAULT_INTERACTION, 150, null, 1);
  assert.equal(held.pinch, true);
  assert.equal(newlyEntered.pinch, false);
  const released = deriveInteractionState(openPalm(), held, 200, 150, 1);
  assert.equal(released.pinch, false);
});

test('a non-square video does not distort gesture distance', () => {
  const square = openPalm();
  const wide = square.map((point) => ({
    x: 0.5 + (point.x - 0.5) / 2,
    y: point.y,
    z: (point.z ?? 0) / 2,
  }));
  const a = deriveInteractionState(square, DEFAULT_INTERACTION, 100, null, 1);
  const b = deriveInteractionState(wide, DEFAULT_INTERACTION, 100, null, 2);
  assert.equal(a.handOpen, b.handOpen);
  assert.equal(a.pinch, b.pinch);
});

test('motion decays on a stationary hand and resets after a tracking gap', () => {
  const start = deriveInteractionState(openPalm(), DEFAULT_INTERACTION, 100, null);
  const target = move(openPalm(), 0.25, 0);
  let current = deriveInteractionState(target, start, 150, 100);
  const moving = current.motion;
  for (let timestamp = 200; timestamp <= 1800; timestamp += 50) {
    current = deriveInteractionState(target, current, timestamp, timestamp - 50);
  }
  assert.ok(moving > 0);
  assert.ok(current.motion < 0.001);
  const reacquired = deriveInteractionState(openPalm(), current, 3000, 1800);
  assert.equal(reacquired.motion, 0);
  assert.equal(reacquired.handX, 0.6);
  assert.equal(deriveInteractionState(target, start, 100, 100).motion, 0);
});

test('degenerate landmarks do not accidentally trigger open or pinch', () => {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const result = deriveInteractionState(points, DEFAULT_INTERACTION, 100, null);
  assert.equal(result.handVisible, true);
  assert.equal(result.pinch, false);
  assert.equal(result.handOpen, false);
});

test('position smoothing remains consistent at different inference rates', () => {
  const target = move(openPalm(), -0.2, 0.1);
  const start = deriveInteractionState(openPalm(), DEFAULT_INTERACTION, 0, null);
  function sample(interval: number) {
    let current = start;
    for (let timestamp = interval; timestamp <= 1000; timestamp += interval) {
      current = deriveInteractionState(target, current, timestamp, timestamp - interval);
    }
    return current;
  }
  const twentyHz = sample(50);
  const tenHz = sample(100);
  assert.ok(Math.abs(twentyHz.handX - tenHz.handX) < 0.000001);
  assert.ok(Math.abs(twentyHz.handY - tenHz.handY) < 0.000001);
});

test('bad previous values and timestamps cannot create non-finite state', () => {
  const previous = {
    ...DEFAULT_INTERACTION,
    handVisible: true,
    handX: NaN,
    handY: Infinity,
    motion: Infinity,
  };
  const result = deriveInteractionState(openPalm(), previous, NaN, Infinity, NaN);
  for (const value of [result.handX, result.handY, result.motion, result.motionVelocity]) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  }
  assert.equal(result.motion, 0);
});
