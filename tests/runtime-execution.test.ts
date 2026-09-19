import assert from 'node:assert/strict';
import {createContext, Script} from 'node:vm';
import test from 'node:test';
import {buildSketchDocument, SKETCH_CHANNEL} from '../lib/sketchRuntime.ts';

const identity = {channel: SKETCH_CHANNEL, instanceId: 'test-runtime-1', worldId: 'physics' as const, revision: 1};
const hand = {handX: 0.2, handY: 0.8, handVisible: true, handOpen: true, pinch: false, motion: 0.1, motionVelocity: 0.1};

/** Minimal browser/p5 boundary double; actual p5 rendering needs browser QA. */
function runtimeHarness(code: string) {
  const events = new Map<string, ((event?: any) => void)[]>();
  const messages: any[] = [];
  const scripts: any[] = [];
  const animations: (() => void)[] = [];
  const immediateTimers: (() => void)[] = [];
  let canvas: any = null;
  let constructions = 0;
  let timerId = 0;
  const parent = {postMessage: (message: unknown) => messages.push(message)};
  const listen = (type: string, callback: (event?: any) => void) => events.set(type, [...events.get(type) || [], callback]);
  const dispatch = (type: string, event?: any) => events.get(type)?.forEach((callback) => callback(event));
  const scope: any = {parent, innerWidth: 420, innerHeight: 240, addEventListener: listen};
  const context = createContext({
    window: scope,
    performance: {now: () => 1_000},
    setTimeout: (callback: () => void, delay: number) => {if (delay === 0) immediateTimers.push(callback); return ++timerId;},
    clearTimeout: () => {},
    setInterval: () => ++timerId,
    clearInterval: () => {},
    requestAnimationFrame: (callback: () => void) => {animations.push(callback); return animations.length;},
    MouseEvent: class {type: string; constructor(type: string, init: object) {this.type = type; Object.assign(this, init);}},
  });
  const append = (script: any) => {
    scripts.push(script);
    if (script.textContent) {
      try {new Script(script.textContent).runInContext(context);}
      catch (error) {dispatch('error', {error, preventDefault() {}});}
    }
  };
  const document = {
    hidden: false,
    readyState: 'complete',
    addEventListener: listen,
    createElement: () => ({}),
    head: {appendChild: append},
    body: {appendChild: append},
    querySelector: () => canvas,
  };
  context.document = document;
  class TestP5 {
    static instance: TestP5 | null = null;
    width = 0;
    height = 0;
    mouseX = 0;
    mouseY = 0;
    _pixelDensity = 2;
    _targetFrameRate = 60;
    _loop = true;
    _setupDone = false;
    constructor() {
      constructions++;
      TestP5.instance = this;
      for (const name of ['createCanvas', 'resizeCanvas', 'pixelDensity', 'frameRate', 'noCanvas', 'noLoop', 'loop', 'isLooping']) {
        scope[name] = (this as any)[name].bind(this);
        context[name] = scope[name];
      }
      this.createCanvas(100, 100);
      scope.setup();
      this._setupDone = true;
      scope.draw();
    }
    _setProperty(name: string, value: unknown) {(this as any)[name] = value; scope[name] = value; context[name] = value;}
    createCanvas(width: number, height: number) {
      this._setProperty('width', width);
      this._setProperty('height', height);
      canvas = {width: width * this._pixelDensity, height: height * this._pixelDensity,
        getBoundingClientRect: () => ({left: 0, top: 0, width, height})};
      return canvas;
    }
    resizeCanvas(width: number, height: number) {return this.createCanvas(width, height);}
    pixelDensity(value?: number) {if (value !== undefined) this._pixelDensity = value; return this._pixelDensity;}
    frameRate(value?: number) {if (value !== undefined) this._targetFrameRate = value; return this._targetFrameRate;}
    noCanvas() {canvas = null;}
    noLoop() {this._loop = false;}
    loop() {this._loop = true;}
    isLooping() {return this._loop;}
    redraw() {scope.draw();}
  }
  const html = buildSketchDocument({...identity, code, nonce: '0123456789abcdef0123456789abcdef', p5Url: 'http://localhost:5173/vendor/p5.min.js'});
  const bootstrap = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1];
  new Script(bootstrap).runInContext(context);
  return {
    scope, scripts, messages,
    get canvas() {return canvas;},
    get instance() {return TestP5.instance;},
    get constructions() {return constructions;},
    loadLibrary() {scope.p5 = TestP5; scripts[0].onload(); immediateTimers.splice(0).forEach((callback) => callback());},
    post(data: object, source: unknown = parent) {dispatch('message', {data: {...identity, ...data}, source});},
    resize(width: number, height: number) {scope.innerWidth = width; scope.innerHeight = height; dispatch('resize'); animations.splice(0).forEach((callback) => callback());},
  };
}

test('transported bootstrap accepts input only from its parent and current generation', () => {
  const runtime = runtimeHarness('function setup() {}');
  assert.equal(runtime.scripts.length, 1);
  assert.equal(runtime.scope.interactionState.handVisible, false);
  runtime.post({type: 'HAND_STATE', payload: hand}, {});
  runtime.post({type: 'HAND_STATE', payload: hand, revision: 0});
  runtime.post({type: 'HAND_STATE', payload: {...hand, handX: NaN}});
  assert.equal(runtime.scope.interactionState.handVisible, false);
  runtime.post({type: 'HAND_STATE', payload: hand});
  assert.equal(runtime.scope.interactionState.handVisible, true);
  assert.equal(runtime.scope.interactionState.handX, 0.2);
  assert.equal(runtime.scripts.length, 1, 'hand input never recreates the vendor or generated script');
});

test('one sketch keeps its state across input and resizing and respects rendering limits', () => {
  const runtime = runtimeHarness('function setup(){ window.starts=(window.starts||0)+1; createCanvas(4000,3000); pixelDensity(4); frameRate(120); } function draw(){window.draws=(window.draws||0)+1;}');
  runtime.loadLibrary();
  assert.equal(runtime.messages[0].type, 'WORLD_READY');
  assert.equal(runtime.constructions, 1);
  assert.equal(runtime.scope.starts, 1);
  assert.equal(runtime.instance?._pixelDensity, 1);
  assert.equal(runtime.instance?._targetFrameRate, 30);
  assert.equal(runtime.canvas.width, 420);
  assert.equal(runtime.canvas.height, 240);
  runtime.post({type: 'HAND_STATE', payload: {...hand, pinch: true}});
  assert.equal(runtime.scope.mouseX, 84);
  assert.equal(runtime.scope.mouseY, 192);
  assert.equal(runtime.scope.mouseIsPressed, true);
  runtime.post({type: 'HAND_STATE', payload: {...hand, handVisible: false}});
  assert.equal(runtime.scope.mouseIsPressed, false, 'losing a pinching hand releases the legacy mouse state');
  runtime.resize(250, 160);
  assert.equal(runtime.canvas.width, 250);
  assert.equal(runtime.canvas.height, 160);
  assert.equal(runtime.scope.starts, 1);
  assert.equal(runtime.constructions, 1);
  runtime.post({type: 'WORLD_VISIBILITY', hidden: true});
  assert.equal(runtime.instance?.isLooping(), false);
  runtime.post({type: 'WORLD_VISIBILITY', hidden: false});
  assert.equal(runtime.instance?.isLooping(), true);
});

test('bad source and missing canvases report errors without affecting a healthy world', () => {
  for (const source of ['', 'const x = ;', 'function setup(){noCanvas();}', 'function draw(){throw new Error("broken draw");}']) {
    const failed = runtimeHarness(source);
    failed.loadLibrary();
    assert.equal(failed.messages.length, 1);
    assert.equal(failed.messages[0].type, 'WORLD_RUNTIME_ERROR');
    assert.equal(failed.messages[0].message.includes('broken draw'), false, 'generated exception text is never sent to the parent');
  }
  const healthy = runtimeHarness('function setup(){createCanvas(20,20);} function draw(){}');
  healthy.loadLibrary();
  assert.equal(healthy.messages[0].type, 'WORLD_READY');
  assert.equal(healthy.instance?.isLooping(), true);
});
