import assert from 'node:assert/strict';
import {createServer, request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {test, type TestContext} from 'node:test';
import {WORLD_IDS} from '../lib/worlds.ts';
import {
  extractSketchCode, GenerationError, MAX_BODY_BYTES, MAX_IMAGE_BYTES,
  MAX_RESPONSE_CHARS, publicGenerationError, thinkingConfigForModel, validateGenerationRequest, validateSketchCode,
} from '../server/generation.ts';
import {
  createGenerationMiddleware, isAllowedLocalRequest, type GenerationMiddlewareOptions,
} from '../server/generationPlugin.ts';
import {buildWorldPrompt} from '../server/prompts.ts';
import {providerDiagnostic} from '../server/providerDiagnostic.ts';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const CODE = 'function setup() { createCanvas(windowWidth, windowHeight); }\nfunction draw() { background(0); }';
const FAKE_KEY = 'fake-key-used-only-in-tests';
const payload = (worldId = 'physics') => ({imageBase64: IMAGE, worldId});
const expectError = (code: string) => (error: unknown) => error instanceof GenerationError && error.code === code;

async function localServer(t: TestContext, options: GenerationMiddlewareOptions = {}) {
  const middleware = createGenerationMiddleware(options);
  const server = createServer((req, res) => middleware(req, res, () => {
    res.writeHead(404);
    res.end();
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin,
    post: (body: unknown = payload(), init: RequestInit = {}) => fetch(`${origin}/api/generate`, {
      method: 'POST', headers: {'content-type': 'application/json', origin}, body: JSON.stringify(body), ...init,
    }),
  };
}

test('snapshot validation retains the same image for each allowed world', () => {
  for (const worldId of WORLD_IDS) {
    const validated = validateGenerationRequest(payload(worldId));
    assert.equal(validated.worldId, worldId);
    assert.equal(validated.image.mimeType, 'image/png');
    assert.equal(validated.image.data, IMAGE.split(',')[1]);
  }
  assert.throws(() => validateGenerationRequest(null), expectError('invalid_body'));
  assert.throws(() => validateGenerationRequest([]), expectError('invalid_body'));
  assert.throws(() => validateGenerationRequest(payload('__proto__')), expectError('invalid_world'));
  assert.throws(() => validateGenerationRequest(payload('PHYSICS')), expectError('invalid_world'));
});

test('rejects non-images, MIME spoofing, invalid base64, and oversized decoded snapshots', () => {
  for (const imageBase64 of [
    IMAGE.replace('image/png', 'image/jpeg'),
    `data:image/png;base64,${Buffer.from('<svg><script>bad()</script></svg>').toString('base64')}`,
    IMAGE.replace('image/png', 'image/svg+xml'),
    IMAGE.replace('base64,', 'base64,%%%'),
    IMAGE.slice(0, -1),
    'https://example.com/snapshot.jpg',
  ]) assert.throws(() => validateGenerationRequest({...payload(), imageBase64}), expectError('invalid_image'));
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  Buffer.from(IMAGE.split(',')[1], 'base64').copy(oversized);
  assert.throws(() => validateGenerationRequest({
    ...payload(), imageBase64: `data:image/png;base64,${oversized.toString('base64')}`,
  }), expectError('image_too_large'));
});

test('extracts fenced, whitespace-padded, raw, and multiple-block JavaScript', () => {
  assert.equal(extractSketchCode(`A short design description.\n\n\`\`\` javascript \r\n ${CODE} \r\n\`\`\``), CODE);
  assert.equal(extractSketchCode(`\n${CODE}\n`), CODE);
  assert.equal(extractSketchCode(`\`\`\`json\n{"concept":"waves"}\n\`\`\`\n\`\`\`JS\n${CODE}\n\`\`\``), CODE);
  const split = '\`\`\`js\nconst tone = 15;\nfunction setup() {}\n\`\`\`\n\`\`\`javascript\nfunction draw() { background(tone); }\n\`\`\`';
  assert.match(extractSketchCode(split), /const tone = 15;/);
  assert.match(extractSketchCode(split), /function draw/);
  const revised = CODE.replace('background(0)', 'background(30)');
  assert.equal(extractSketchCode(`\`\`\`js\n${CODE}\n\`\`\`\n\`\`\`js\n${revised}\n\`\`\``), revised);
});

test('requires declared global p5 callbacks without executing the generated code', () => {
  assert.equal(validateSketchCode(CODE), true);
  assert.equal(validateSketchCode(`throw new Error('Must never execute during validation');\n${CODE}`), true);
  assert.equal(validateSketchCode('window.setup = () => {}; window.draw = function () {};'), true);
  assert.equal(validateSketchCode('// function setup() {}\n// function draw() {}'), false);
  assert.equal(validateSketchCode('const text = "function setup() {} function draw() {}";'), false);
  assert.equal(validateSketchCode(`function hidden() { ${CODE} }`), false);
  assert.equal(validateSketchCode('async function setup() {} function draw() {}'), false);
  assert.equal(validateSketchCode('function setup() {} function draw() {'), false);
  assert.throws(() => extractSketchCode('Sorry, I cannot create this scene.'), expectError('invalid_code'));
  assert.throws(() => extractSketchCode(''), expectError('empty_response'));
  assert.throws(() => extractSketchCode('x'.repeat(MAX_RESPONSE_CHARS + 1)), expectError('response_too_large'));
});

test('upstream error messages and credential-shaped values never enter public errors', () => {
  for (const [status, expected] of [[429, 429], [401, 502], [403, 502], [404, 502], [500, 502], [504, 504]]) {
    const safe = publicGenerationError({status, message: `upstream URL https://secret.test/?key=${FAKE_KEY}`});
    assert.equal(safe.status, expected);
    assert.doesNotMatch(JSON.stringify(safe), /fake-key|secret\.test|stack/);
  }
  assert.match(publicGenerationError({status: 400, message: `API_KEY_INVALID ${FAKE_KEY}`}).error, /credentials/);
  const restrictedModel = publicGenerationError({
    status: 404, message: `This model is no longer available to new users. https://private.test/?key=${FAKE_KEY}`,
  });
  assert.equal(restrictedModel.status, 502);
  assert.match(restrictedModel.error, /unavailable to new API users/);
  assert.doesNotMatch(restrictedModel.error, /fake-key|private\.test/);
  assert.equal(publicGenerationError(new Error(FAKE_KEY)).status, 502);
  assert.equal(publicGenerationError(new GenerationError('timeout')).status, 504);
});

test('provider diagnostics retain exact HTTP failure classes using only safe fixed values', () => {
  const secretMessage = `Do not expose https://private.test/?key=${FAKE_KEY}`;
  assert.deepEqual(providerDiagnostic({status: 503, message: `High demand. ${secretMessage}`}), {
    status: 503, code: 'UNAVAILABLE', reason: 'HIGH_DEMAND',
  });
  assert.deepEqual(providerDiagnostic({status: 503, message: secretMessage}), {
    status: 503, code: 'UNAVAILABLE', reason: 'SERVICE_UNAVAILABLE',
  });
  assert.deepEqual(providerDiagnostic({status: 400, message: secretMessage}), {
    status: 400, code: 'INVALID_ARGUMENT', reason: 'REQUEST_REJECTED',
  });
  assert.deepEqual(providerDiagnostic({name: 'TypeError', message: `fetch failed ${secretMessage}`}), {
    status: null, code: 'TRANSPORT_ERROR', reason: 'CONNECTION_FAILURE',
  });
  for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 503, 504, undefined]) {
    const diagnostic = providerDiagnostic({status, message: secretMessage, key: FAKE_KEY, stack: secretMessage});
    assert.doesNotMatch(JSON.stringify(diagnostic), /fake-key|private\.test|stack/);
  }
});

test('world directions preserve the original image interpretation process and differ in hand response', () => {
  const prompts = WORLD_IDS.map(buildWorldPrompt);
  assert.equal(new Set(prompts).size, 4);
  for (const prompt of prompts) {
    assert.match(prompt, /upper body/);
    assert.match(prompt, /bounding boxes/);
    assert.match(prompt, /window\.interactionState/);
    assert.match(prompt, /pixelDensity\(1\)/);
    assert.match(prompt, /frameRate\(30\)/);
    assert.match(prompt, /maximum of 180/);
  }
  assert.match(prompts[0], /attraction force/);
  assert.match(prompts[1], /local vortex/);
  assert.match(prompts[2], /direction of growth/);
  assert.match(prompts[3], /deforms the nearby geometry/);
});

test('low-latency thinking applies to supported Flash models without breaking older model overrides', () => {
  for (const model of ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview', 'models/gemini-3.6-flash']) {
    assert.deepEqual(thinkingConfigForModel(model), {thinkingLevel: 'LOW'});
  }
  for (const model of ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image']) {
    assert.equal(thinkingConfigForModel(model), undefined);
  }
});

test('local origin policy rejects null origins, cross-site requests, and DNS rebinding hosts', () => {
  assert.equal(isAllowedLocalRequest({host: 'localhost:3000', origin: 'http://localhost:3000'}), true);
  assert.equal(isAllowedLocalRequest({host: '127.0.0.1:3000'}), true);
  assert.equal(isAllowedLocalRequest({host: '[::1]:3000', origin: 'http://[::1]:3000'}), true);
  assert.equal(isAllowedLocalRequest({host: 'localhost', origin: 'https://localhost'}, true), true);
  for (const headers of [
    {host: 'localhost:3000', origin: 'null'},
    {host: 'localhost:3000', origin: 'https://attacker.example'},
    {host: 'localhost:3000', origin: 'http://localhost:3001'},
    {host: 'localhost:3000', origin: 'http://localhost:3000/path'},
    {host: 'localhost:3000', 'sec-fetch-site': 'cross-site'},
    {host: 'localhost:3000', 'sec-fetch-site': 'same-site'},
    {host: 'localhost.attacker.example:3000'},
    {host: 'rebind.example:3000'},
    {},
  ]) assert.equal(isAllowedLocalRequest(headers), false);
});

test('health discloses configuration status and model but never the server key', async (t) => {
  const app = await localServer(t, {apiKey: FAKE_KEY, model: 'gemini-test-model', generate: async () => CODE});
  const response = await fetch(`${app.origin}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {configured: true, model: 'gemini-test-model'});
  const unconfigured = await localServer(t);
  assert.deepEqual(await (await fetch(`${unconfigured.origin}/api/health`)).json(), {configured: false, model: 'gemini-3.6-flash'});
  assert.equal((await unconfigured.post()).status, 503);
});

test('HTTP rejects invalid methods, foreign origins, content types and JSON before contacting Gemini', async (t) => {
  let calls = 0;
  const app = await localServer(t, {apiKey: FAKE_KEY, generate: async () => { calls += 1; return CODE; }});
  const method = await fetch(`${app.origin}/api/generate`);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  assert.equal((await fetch(`${app.origin}/api/health`, {method: 'POST'})).status, 405);
  for (const origin of ['null', 'https://attacker.example']) {
    const response = await app.post(payload(), {headers: {'content-type': 'application/json', origin}});
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await app.post(payload(), {headers: {'content-type': 'text/plain'}})).status, 415);
  assert.equal((await app.post(payload(), {body: '{invalid-json'})).status, 400);
  assert.equal((await app.post(payload('unknown'))).status, 400);
  assert.equal((await app.post({worldId: 'physics', imageBase64: 'not a snapshot'})).status, 400);
  assert.equal(calls, 0);
});

test('four independent requests reuse the snapshot and retain successful worlds after an isolated error', async (t) => {
  const received: Array<{worldId: string; image: string}> = [];
  const app = await localServer(t, {apiKey: FAKE_KEY, generate: async (input) => {
    received.push({worldId: input.worldId, image: input.image.data});
    if (input.worldId === 'organic') throw {status: 429, message: FAKE_KEY};
    return `A concise interpretation.\n\`\`\`javascript\n${CODE}\n\`\`\``;
  }});
  const results = await Promise.all(WORLD_IDS.map(async (id) => {
    const response = await app.post(payload(id));
    return {id, status: response.status, body: await response.json()};
  }));
  assert.equal(received.length, 4);
  assert.equal(new Set(received.map(({image}) => image)).size, 1);
  assert.equal(results.filter(({status}) => status === 200).length, 3);
  assert.equal(results.find(({id}) => id === 'organic')?.status, 429);
  for (const result of results.filter(({status}) => status === 200)) {
    assert.equal(result.body.code, CODE);
    assert.match(result.body.fullResponse, /concise interpretation/);
  }
  assert.doesNotMatch(JSON.stringify(results), /fake-key/);
});

test('a defensive exact-key redaction also covers model output before returning it', async (t) => {
  const app = await localServer(t, {apiKey: FAKE_KEY, generate: async () => `// ${FAKE_KEY}\n${CODE}`});
  const response = await app.post();
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /fake-key/);
  assert.match(body, /REDACTED/);
});

test('a deadline aborts the upstream request and a retry can use the released slot', async (t) => {
  let signal: AbortSignal | undefined;
  let calls = 0;
  const app = await localServer(t, {apiKey: FAKE_KEY, timeoutMs: 100, maxConcurrent: 1, generate: (_input, abortSignal) => {
    calls += 1;
    signal = abortSignal;
    return calls === 1 ? new Promise(() => {}) : Promise.resolve(CODE);
  }});
  const response = await app.post();
  assert.equal(response.status, 504);
  assert.equal(signal?.aborted, true);
  assert.equal((await app.post()).status, 200);
});

test('caps in-flight generation rather than queueing unlimited billed requests', async (t) => {
  let release: (value: string) => void = () => {};
  const pending = new Promise<string>((resolve) => { release = resolve; });
  let started: () => void = () => {};
  const began = new Promise<void>((resolve) => { started = resolve; });
  const app = await localServer(t, {apiKey: FAKE_KEY, maxConcurrent: 1, generate: async () => { started(); return pending; }});
  const first = app.post();
  await began;
  const excess = await app.post();
  assert.equal(excess.status, 503);
  assert.equal(excess.headers.get('retry-after'), '5');
  release(CODE);
  assert.equal((await first).status, 200);
  assert.equal((await app.post()).status, 200);
});

test('closing the browser request propagates cancellation to Gemini', async (t) => {
  let started: () => void = () => {};
  const began = new Promise<void>((resolve) => { started = resolve; });
  let cancelled: () => void = () => {};
  const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
  const app = await localServer(t, {apiKey: FAKE_KEY, generate: async (_input, signal) => {
    signal.addEventListener('abort', cancelled, {once: true});
    started();
    return new Promise(() => {});
  }});
  const controller = new AbortController();
  const request = app.post(payload(), {signal: controller.signal}).catch(() => undefined);
  await began;
  controller.abort();
  await request;
  await aborted;
});

test('disconnecting partway through a snapshot releases the upload slot', async (t) => {
  const app = await localServer(t, {apiKey: FAKE_KEY, maxConcurrent: 1, generate: async () => CODE});
  const incoming = once(app.server, 'request');
  const req = httpRequest(`${app.origin}/api/generate`, {method: 'POST', headers: {
    'content-type': 'application/json', 'content-length': 1000,
  }});
  req.on('error', () => {});
  req.write('{"worldId":');
  const [upload] = await incoming;
  const aborted = once(upload, 'aborted');
  req.destroy();
  await aborted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await app.post()).status, 200);
});

test('rejects oversized streamed JSON before invoking generation', async (t) => {
  let calls = 0;
  const app = await localServer(t, {apiKey: FAKE_KEY, generate: async () => { calls += 1; return CODE; }});
  const response = await new Promise<{status: number; body: string}>((resolve, reject) => {
    const req = httpRequest(`${app.origin}/api/generate`, {method: 'POST', headers: {
      'content-type': 'application/json', 'transfer-encoding': 'chunked',
    }}, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({status: res.statusCode ?? 0, body}));
    });
    req.on('error', reject);
    req.end('x'.repeat(MAX_BODY_BYTES + 1));
  });
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
  assert.match(response.body, /too large/);
});

test('unfinished uploads have a separate short body timeout', async (t) => {
  const app = await localServer(t, {apiKey: FAKE_KEY, bodyTimeoutMs: 80, generate: async () => CODE});
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${app.origin}/api/generate`, {method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': 100,
    }}, (res) => {
      res.resume();
      res.on('end', () => { req.destroy(); resolve(res.statusCode ?? 0); });
    });
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(status, 408);
});
