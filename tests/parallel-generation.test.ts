import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGenerationController, type WorldRequest} from '../lib/parallelGeneration.ts';
import {WORLD_IDS, type GenerateResponse, type WorldId, type WorldOutput} from '../lib/worlds.ts';

const SNAPSHOT_A = 'data:image/jpeg;base64,c25hcHNob3QtQS1leGFjdC1ieXRlcw==';
const SNAPSHOT_B = 'data:image/jpeg;base64,c25hcHNob3QtQi1kaWZmZXJlbnQtYnl0ZXM=';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return {promise, resolve, reject};
}

interface PendingWorld extends ReturnType<typeof deferred<GenerateResponse>> {
  snapshot: string;
  worldId: WorldId;
  signal: AbortSignal;
}

function sketch(label: string): GenerateResponse {
  return {code: `function setup() {} function draw() { /* ${label} */ }`, fullResponse: `Interpretation: ${label}`};
}

function harness(onPublish?: (worlds: WorldOutput[]) => void) {
  const calls: PendingWorld[] = [];
  const publications: WorldOutput[][] = [];
  const request: WorldRequest = (snapshot, worldId, signal) => {
    // Deliberately ignore abort: the controller must also reject stale callbacks.
    const pending = {...deferred<GenerateResponse>(), snapshot, worldId, signal};
    calls.push(pending);
    return pending.promise;
  };
  const controller = createGenerationController((worlds) => {
    publications.push(worlds);
    onPublish?.(worlds);
  }, request);
  return {
    controller, calls, publications,
    latest: () => publications.at(-1)!,
    world: (id: WorldId) => publications.at(-1)!.find((world) => world.id === id)!,
  };
}

async function fulfill(call: PendingWorld, label: string = call.worldId) {
  const result = sketch(label);
  call.resolve(result);
  // The controller subscribed to this promise before this continuation. Its
  // synchronous publication/finally cleanup is complete when this await resumes.
  await call.promise;
  return result;
}

async function reject(call: PendingWorld, message = 'This world failed.') {
  call.reject(new Error(message));
  await assert.rejects(call.promise, {message});
}

test('starts all four requests concurrently and publishes one complete loading state', () => {
  const app = harness();
  app.controller.start(SNAPSHOT_A);

  assert.equal(app.calls.length, 4, 'all requests start before any promise resolves');
  assert.deepEqual(app.calls.map(({worldId}) => worldId), [...WORLD_IDS]);
  assert(app.calls.every(({snapshot, signal}) => snapshot === SNAPSHOT_A && !signal.aborted));
  assert.equal(app.publications.length, 1);
  assert.equal(app.latest().length, 4);
  assert(app.latest().every(({status, code, fullResponse, error, revision}) =>
    status === 'loading' && code === '' && fullResponse === '' && error === null && revision > 0));
  assert.equal(new Set(app.latest().map(({revision}) => revision)).size, 1);
  app.controller.dispose();
});

test('publishes each world immediately in completion order without waiting for the other three', async () => {
  const app = harness();
  app.controller.start(SNAPSHOT_A);
  const completionOrder: WorldId[] = ['organic', 'physics', 'abstract', 'particle'];
  const finished = new Set<WorldId>();

  for (const id of completionOrder) {
    const call = app.calls.find(({worldId}) => worldId === id)!;
    const result = await fulfill(call);
    finished.add(id);
    assert.equal(app.publications.length, finished.size + 1);
    assert.equal(app.world(id).code, result.code);
    assert.equal(app.world(id).fullResponse, result.fullResponse);
    for (const world of app.latest()) {
      assert.equal(world.status, finished.has(world.id) ? 'success' : 'loading');
    }
  }
  // Previously published frames are immutable snapshots, including the first reveal.
  assert.equal(app.publications[1].find(({id}) => id === 'organic')?.status, 'success');
  assert.equal(app.publications[1].find(({id}) => id === 'physics')?.status, 'loading');
  app.controller.dispose();
});

test('an isolated failure preserves completed worlds while remaining requests still finish', async () => {
  const app = harness();
  app.controller.start(SNAPSHOT_A);
  const physics = await fulfill(app.calls[0]);
  await reject(app.calls[2], 'Gemini quota reached. Retry this frame.');

  assert.equal(app.world('organic').status, 'error');
  assert.equal(app.world('organic').error, 'Gemini quota reached. Retry this frame.');
  assert.equal(app.world('physics').status, 'success');
  assert.equal(app.world('physics').code, physics.code);
  assert.equal(app.world('particle').status, 'loading');
  assert.equal(app.world('abstract').status, 'loading');

  await fulfill(app.calls[3]);
  await fulfill(app.calls[1]);
  assert.equal(app.latest().filter(({status}) => status === 'success').length, 3);
  assert.equal(app.latest().filter(({status}) => status === 'error').length, 1);
  assert.equal(app.world('physics').code, physics.code);
  app.controller.dispose();
});

test('retry requests only the failed world with the identical saved snapshot', async () => {
  const app = harness();
  app.controller.start(SNAPSHOT_A);
  for (const call of app.calls) {
    if (call.worldId === 'organic') await reject(call);
    else await fulfill(call);
  }
  const before = app.latest();
  const failedRevision = app.world('organic').revision;
  app.controller.retry('organic');

  assert.equal(app.calls.length, 5);
  assert.equal(app.calls[4].worldId, 'organic');
  assert.equal(app.calls[4].snapshot, SNAPSHOT_A);
  assert.deepEqual(app.latest().filter(({id}) => id !== 'organic'), before.filter(({id}) => id !== 'organic'));
  assert.equal(app.world('organic').status, 'loading');
  assert.equal(app.world('organic').error, null);
  assert.equal(app.world('organic').code, '');
  assert.equal(app.world('organic').fullResponse, '');
  assert(app.world('organic').revision > failedRevision);

  app.controller.retry('organic'); // Repeated clicks during loading cannot duplicate billing.
  app.controller.retry('physics'); // Successful frames are preserved.
  assert.equal(app.calls.length, 5);
  await fulfill(app.calls[4], 'organic retry');
  assert(app.latest().every(({status}) => status === 'success'));
  assert.deepEqual(app.latest().filter(({id}) => id !== 'organic'), before.filter(({id}) => id !== 'organic'));
  app.controller.dispose();
});

test('re-imagine resets all four worlds but reuses the exact caller snapshot', async () => {
  const app = harness();
  app.controller.start(SNAPSHOT_A);
  for (const call of app.calls) await fulfill(call, `first ${call.worldId}`);
  const previousRevision = app.world('physics').revision;

  app.controller.start(SNAPSHOT_A);
  assert.equal(app.calls.length, 8);
  assert(app.calls.every(({snapshot}) => snapshot === SNAPSHOT_A));
  assert(app.latest().every(({status, code, fullResponse, error, revision}) =>
    status === 'loading' && code === '' && fullResponse === '' && error === null && revision > previousRevision));

  const result = await fulfill(app.calls[7], 're-imagined abstract');
  assert.equal(app.world('abstract').code, result.code);
  assert.equal(app.world('physics').status, 'loading');
  app.controller.dispose();
});

test('a new capture aborts the old batch and ignores late successes and failures even if requests ignore abort', async () => {
  const app = harness();
  app.controller.start(SNAPSHOT_A);
  const oldCalls = app.calls.slice();
  app.controller.start(SNAPSHOT_B);
  const newCalls = app.calls.slice(4);

  assert(oldCalls.every(({signal}) => signal.aborted));
  assert(newCalls.every(({snapshot, signal}) => snapshot === SNAPSHOT_B && !signal.aborted));
  assert.equal(app.publications.length, 2);
  const organic = await fulfill(newCalls[2], 'new organic');
  const count = app.publications.length;

  await fulfill(oldCalls[2], 'stale organic');
  await reject(oldCalls[0], 'stale physics error');
  await fulfill(oldCalls[1], 'stale particle');
  await fulfill(oldCalls[3], 'stale abstract');
  assert.equal(app.publications.length, count, 'stale callbacks must not publish anything');
  assert.equal(app.world('organic').code, organic.code);
  assert.equal(app.world('physics').status, 'loading');

  // Old finally blocks must not remove the controllers belonging to the new batch.
  for (const call of newCalls.filter(({worldId}) => worldId !== 'organic')) {
    await fulfill(call, `new ${call.worldId}`);
  }
  assert(app.latest().every(({status, code}) => status === 'success' && code.includes('new ')));
  app.controller.dispose();
});

test('a synchronous retry from the error callback survives the previous request finally cleanup', async () => {
  let retried = false;
  const app = harness((worlds) => {
    if (!retried && worlds.some(({id, status}) => id === 'particle' && status === 'error')) {
      retried = true;
      app.controller.retry('particle');
    }
  });
  app.controller.start(SNAPSHOT_A);
  const failed = app.calls[1];
  await reject(failed, 'Retry immediately');

  assert.equal(app.calls.length, 5);
  assert.equal(app.calls[4].worldId, 'particle');
  assert.equal(app.calls[4].snapshot, SNAPSHOT_A);
  assert.equal(failed.signal.aborted, true);
  assert.equal(app.world('particle').status, 'loading');
  const result = await fulfill(app.calls[4], 'surviving retry');
  assert.equal(app.world('particle').status, 'success');
  assert.equal(app.world('particle').code, result.code);
  app.controller.dispose();
});

test('late retry results cannot replace a newer capture and the next retry uses that new snapshot', async () => {
  const app = harness();
  app.controller.start(SNAPSHOT_A);
  await reject(app.calls[0]);
  app.controller.retry('physics');
  const oldRetry = app.calls[4];

  app.controller.start(SNAPSHOT_B);
  const currentPhysics = app.calls[5];
  assert.equal(oldRetry.signal.aborted, true);
  const count = app.publications.length;
  await fulfill(oldRetry, 'stale retry from snapshot A');
  assert.equal(app.publications.length, count);
  await reject(currentPhysics, 'Snapshot B needs a retry');
  app.controller.retry('physics');
  assert.equal(app.calls.length, 10);
  assert.equal(app.calls[9].snapshot, SNAPSHOT_B);
  const result = await fulfill(app.calls[9], 'snapshot B retry');
  assert.equal(app.world('physics').code, result.code);
  app.controller.dispose();
});

test('runtime errors apply only to a successful frame with the matching revision', async () => {
  const app = harness();
  app.controller.start(SNAPSHOT_A);
  const originalRevision = app.world('physics').revision;
  app.controller.runtimeError('physics', originalRevision, 'Too early');
  assert.equal(app.publications.length, 1, 'a loading frame cannot fail from a stale runtime callback');

  const initial = await fulfill(app.calls[0]);
  const beforeStale = app.publications.length;
  app.controller.runtimeError('physics', originalRevision - 1, 'Old iframe');
  assert.equal(app.publications.length, beforeStale);
  app.controller.runtimeError('physics', originalRevision, 'Drawing failed');
  assert.equal(app.world('physics').status, 'error');
  assert.equal(app.world('physics').error, 'Drawing failed');
  assert.equal(app.world('physics').code, initial.code);

  app.controller.retry('physics');
  const newRevision = app.world('physics').revision;
  assert(newRevision > originalRevision);
  await fulfill(app.calls[4], 'corrected physics');
  const beforeOldIframe = app.publications.length;
  app.controller.runtimeError('physics', originalRevision, 'Old iframe reported after retry succeeded');
  assert.equal(app.publications.length, beforeOldIframe);
  assert.equal(app.world('physics').status, 'success');

  app.controller.runtimeError('physics', newRevision, '');
  assert.equal(app.world('physics').status, 'error');
  assert.equal(app.world('physics').error, 'This sketch stopped. Please retry this world.');
  const afterError = app.publications.length;
  app.controller.runtimeError('physics', newRevision, 'Duplicate runtime report');
  assert.equal(app.publications.length, afterError);
  app.controller.dispose();
});

test('dispose aborts outstanding work and prevents every later publication or request', async () => {
  const app = harness();
  app.controller.start(SNAPSHOT_A);
  const revision = app.world('physics').revision;
  const count = app.publications.length;
  app.controller.dispose();
  app.controller.dispose();
  assert(app.calls.every(({signal}) => signal.aborted));

  await fulfill(app.calls[0], 'resolved after dispose');
  await reject(app.calls[1], 'rejected after dispose');
  await fulfill(app.calls[2]);
  await fulfill(app.calls[3]);
  app.controller.start(SNAPSHOT_B);
  app.controller.retry('particle');
  app.controller.runtimeError('physics', revision, 'Late iframe event');
  assert.equal(app.publications.length, count);
  assert.equal(app.calls.length, 4);
});

test('empty captures and retries without an existing failed world are no-ops', () => {
  const app = harness();
  app.controller.start('');
  app.controller.retry('physics');
  app.controller.runtimeError('physics', 0, 'No frame exists');
  assert.equal(app.calls.length, 0);
  assert.equal(app.publications.length, 0);

  app.controller.start(SNAPSHOT_A);
  app.controller.retry('physics');
  app.controller.retry('invalid' as WorldId);
  assert.equal(app.calls.length, 4);
  assert.equal(app.publications.length, 1);
  app.controller.dispose();
});

test('a synchronous request exception does not prevent the remaining worlds from starting', async () => {
  const ids: WorldId[] = [];
  const publications: WorldOutput[][] = [];
  const controller = createGenerationController((worlds) => publications.push(worlds), (_snapshot, id) => {
    ids.push(id);
    if (id === 'physics') throw new Error('Immediate failure');
    return Promise.resolve(sketch(id));
  });
  controller.start(SNAPSHOT_A);
  assert.deepEqual(ids, [...WORLD_IDS]);
  await Promise.resolve();
  const latest = publications.at(-1)!;
  assert.equal(latest.find(({id}) => id === 'physics')?.status, 'error');
  assert.equal(latest.filter(({status}) => status === 'success').length, 3);
  controller.dispose();
});
