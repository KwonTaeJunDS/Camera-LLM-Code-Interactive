import {useCallback, useEffect, useRef, useState} from 'react';
import {createGenerationController} from '../lib/parallelGeneration';
import {createWorlds, type WorldId} from '../lib/worlds';

export function useParallelWorlds() {
  const [worlds, setWorlds] = useState(createWorlds);
  const controllerRef = useRef<ReturnType<typeof createGenerationController> | null>(null);

  useEffect(() => {
    const controller = createGenerationController(setWorlds);
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  const generate = useCallback((snapshot: string) => controllerRef.current?.start(snapshot), []);
  const retry = useCallback((id: WorldId) => controllerRef.current?.retry(id), []);
  const runtimeError = useCallback((id: WorldId, revision: number, message: string) => {
    controllerRef.current?.runtimeError(id, revision, message);
  }, []);

  return {
    worlds, generate, retry, runtimeError,
    generating: worlds.some((world) => world.status === 'loading'),
    readyCount: worlds.filter((world) => world.status === 'success').length,
    settled: worlds.every((world) => world.status === 'success' || world.status === 'error'),
  };
}
