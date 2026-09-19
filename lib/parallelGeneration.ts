import {createWorlds, WORLD_IDS, type GenerateResponse, type WorldId, type WorldOutput} from './worlds.ts';

export type WorldRequest = (snapshot: string, worldId: WorldId, signal: AbortSignal) => Promise<GenerateResponse>;

export async function requestWorld(snapshot: string, worldId: WorldId, signal: AbortSignal): Promise<GenerateResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, {once: true});
  if (signal.aborted) cancel();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 100_000);

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({imageBase64: snapshot, worldId}),
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message = typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string'
        ? result.error : 'This world could not be generated. Please retry.';
      throw new Error(message);
    }
    if (typeof result !== 'object' || result === null || !('code' in result) ||
        typeof result.code !== 'string' || !result.code.trim() ||
        !('fullResponse' in result) || typeof result.fullResponse !== 'string') {
      throw new Error('The model returned an incomplete sketch. Please retry.');
    }
    return {code: result.code, fullResponse: result.fullResponse};
  } catch (error) {
    if (timedOut) throw new Error('Generation took too long. Please retry this world.');
    if (signal.aborted) throw new DOMException('Generation cancelled', 'AbortError');
    if (error instanceof TypeError) throw new Error('Cannot reach the local server. Check that npm run dev is still running.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}

/** Owns request lifetimes, so out-of-order and cancelled responses cannot replace newer worlds. */
export function createGenerationController(onChange: (worlds: WorldOutput[]) => void, request: WorldRequest = requestWorld) {
  let worlds = createWorlds();
  let snapshot = '';
  let generation = 0;
  let revision = 0;
  let disposed = false;
  const controllers = new Map<WorldId, AbortController>();

  const emit = () => { if (!disposed) onChange([...worlds]); };
  const patch = (id: WorldId, changes: Partial<WorldOutput>) => {
    worlds = worlds.map((world) => world.id === id ? {...world, ...changes} : world);
    emit();
  };
  const run = async (id: WorldId, currentGeneration: number, currentSnapshot: string) => {
    controllers.get(id)?.abort();
    const controller = new AbortController();
    controllers.set(id, controller);
    const isCurrent = () => !disposed && !controller.signal.aborted && generation === currentGeneration && controllers.get(id) === controller;
    try {
      const result = await request(currentSnapshot, id, controller.signal);
      if (isCurrent()) patch(id, {...result, status: 'success', error: null});
    } catch (error) {
      if (isCurrent()) patch(id, {
        status: 'error',
        error: error instanceof Error ? error.message : 'This world could not be generated. Please retry.',
      });
    } finally {
      if (controllers.get(id) === controller) controllers.delete(id);
    }
  };

  return {
    start(nextSnapshot: string) {
      if (disposed || !nextSnapshot) return;
      generation += 1;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      snapshot = nextSnapshot;
      worlds = createWorlds('loading', ++revision);
      emit();
      // Each response publishes immediately. Never wait for all four requests to finish.
      for (const id of WORLD_IDS) void run(id, generation, snapshot);
    },
    retry(id: WorldId) {
      if (disposed || !snapshot || !worlds.some((world) => world.id === id && world.status === 'error')) return;
      patch(id, {status: 'loading', code: '', fullResponse: '', error: null, revision: ++revision});
      void run(id, generation, snapshot);
    },
    runtimeError(id: WorldId, worldRevision: number, message: string) {
      if (disposed || !worlds.some((world) => world.id === id && world.revision === worldRevision && world.status === 'success')) return;
      patch(id, {status: 'error', error: message || 'This sketch stopped. Please retry this world.'});
    },
    dispose() {
      disposed = true;
      generation += 1;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      snapshot = '';
    },
  };
}
