import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import test from 'node:test';
import {buildSketchDocument, normalizeInteractionPayload, readSketchMessage, SKETCH_CHANNEL} from '../lib/sketchRuntime.ts';

const identity = {instanceId: 'physics-2-instance', worldId: 'physics' as const, revision: 2};
const options = {...identity, nonce: '0123456789abcdef0123456789abcdef', p5Url: 'http://localhost:5173/vendor/p5.min.js'};
const hand = {handX: 0.2, handY: 0.8, handVisible: true, handOpen: true, pinch: false, motion: 0.1, motionVelocity: 0.1};

test('hand input rejects malformed messages rather than coercing untrusted values', () => {
  for (const invalid of [null, [], 'state', {...hand, handX: NaN}, {...hand, handY: Infinity}, {...hand, motion: '0.8'}, {...hand, motionVelocity: -Infinity}, {...hand, pinch: 1}, {...hand, handVisible: 'false'}]) {
    assert.equal(normalizeInteractionPayload(invalid), null);
  }
});

test('hand input clamps coordinates and clears gestures after tracking is lost', () => {
  assert.deepEqual(normalizeInteractionPayload({...hand, handX: -2, handY: 4, motion: 5, motionVelocity: -1}), {...hand, handX: 0, handY: 1, motion: 1, motionVelocity: 0});
  assert.deepEqual(normalizeInteractionPayload({...hand, handVisible: false, pinch: true}), {...hand, handVisible: false, handOpen: false, pinch: false, motion: 0, motionVelocity: 0});
  const withExtra = normalizeInteractionPayload({...hand, dangerous: 'ignored'});
  assert.deepEqual(withExtra, hand);
  assert.notEqual(withExtra, hand);
});

test('runtime events cannot cross world, revision, or instance boundaries', () => {
  const message = {...identity, channel: SKETCH_CHANNEL, type: 'WORLD_RUNTIME_ERROR', reason: 'runtime', message: 'draw failed'};
  assert.equal(readSketchMessage(message, identity)?.type, 'WORLD_RUNTIME_ERROR');
  for (const changed of [{worldId: 'organic'}, {revision: 1}, {instanceId: 'old-instance'}, {channel: 'another-app'}, {type: 'HAND_STATE'}, {reason: ''}, {reason: '__proto__'}]) {
    assert.equal(readSketchMessage({...message, ...changed}, identity), null);
  }
  assert.equal(readSketchMessage({...message, message: 'x'.repeat(2000)}, identity)?.type === 'WORLD_RUNTIME_ERROR', true);
  const longError = readSketchMessage({...message, message: 'x'.repeat(2000)}, identity);
  assert.ok(longError?.type === 'WORLD_RUNTIME_ERROR');
  assert.equal(longError.message, 'This world could not run. Retry this frame.');
});

test('generated HTML/script breakout strings remain encoded JavaScript data', () => {
  const source = 'const label = "</script><img src=x onerror=alert(1)>";\nfunction setup(){createCanvas(400,400)}\nfunction draw(){background(0)}\n// \u2028 \u2029';
  const html = buildSketchDocument({...options, code: source});
  assert.equal((html.match(/<script\b/gi) || []).length, 1);
  assert.equal((html.match(/<\/script>/gi) || []).length, 1);
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('\\u003c/script\\u003e'));
  const bootstrap = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)?.[1];
  assert.ok(bootstrap);
  assert.doesNotThrow(() => new Script(bootstrap));
});

test('runtime CSP permits only the pinned local vendor path and nonce inline execution', () => {
  const html = buildSketchDocument({...options, code: 'function setup() {}'});
  assert.equal((html.match(/http-equiv="Content-Security-Policy"/g) || []).length, 2);
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "script-src-attr 'none'"]) assert.ok(html.includes(directive));
  assert.ok(html.includes(`script-src 'nonce-${options.nonce}' ${options.p5Url}`));
  assert.equal(html.includes("'unsafe-eval'"), false);
  assert.equal(html.includes('cdnjs'), false);
  for (const p5Url of ['https://example.com/other.js', 'http://localhost:5173/vendor/p5.min.js?x=1', 'javascript:alert(1)', 'http://user:password@localhost/vendor/p5.min.js']) {
    assert.throws(() => buildSketchDocument({...options, code: '', p5Url}));
  }
  assert.throws(() => buildSketchDocument({...options, code: '', nonce: '"><script>bad'}));
});
