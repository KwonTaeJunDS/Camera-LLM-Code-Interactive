import {memo, useCallback, type MutableRefObject} from 'react';
import CodePreview from './CodePreview';
import type {InteractionState} from '../lib/interaction';
import {WORLD_META, type WorldId, type WorldOutput} from '../lib/worlds';

interface Props {
  world: WorldOutput;
  interactionRef: MutableRefObject<InteractionState>;
  onRetry: (id: WorldId) => void;
  onRuntimeError: (id: WorldId, revision: number, message: string) => void;
}

export default memo(function WorldFrame({world, interactionRef, onRetry, onRuntimeError}: Props) {
  const meta = WORLD_META[world.id];
  const reportError = useCallback((id: WorldId, message: string) => {
    onRuntimeError(id, world.revision, message);
  }, [onRuntimeError, world.revision]);

  return (
    <figure className={`world-frame world-frame--${world.id}`} data-world={world.id} data-status={world.status} aria-label={`${meta.label} world`}>
      <div className="world-canvas">
        {world.status === 'success' ? (
          <CodePreview key={world.revision} output={world} interactionRef={interactionRef} onRuntimeError={reportError} />
        ) : world.status === 'error' ? (
          <div className="world-message world-message--error" role="status">
            <p>{world.error}</p>
            <button className="retry-world" type="button" onClick={() => onRetry(world.id)} aria-label={`Retry ${world.id} world`}>
              RETRY
            </button>
          </div>
        ) : (
          <div className={`world-placeholder ${world.status === 'loading' ? 'is-generating' : ''}`} role={world.status === 'loading' ? 'status' : undefined}>
            {world.status === 'loading' && <><i className="tiny-loader" aria-hidden="true" /><span className="sr-only">Generating {meta.label.toLowerCase()} world.</span></>}
          </div>
        )}
      </div>
    </figure>
  );
});
