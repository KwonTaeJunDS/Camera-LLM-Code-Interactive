/** Shared contracts for the four interpretations of a single camera snapshot. */
export const WORLD_IDS = ['physics', 'particle', 'organic', 'abstract'] as const;

export type WorldId = (typeof WORLD_IDS)[number];
export type WorldStatus = 'idle' | 'loading' | 'success' | 'error';

export interface WorldOutput {
  id: WorldId;
  status: WorldStatus;
  code: string;
  fullResponse: string;
  error: string | null;
  revision: number;
}

export const WORLD_META: Record<WorldId, {number: string; label: string; concept: string}> = {
  physics: {number: '01', label: 'PHYSICS', concept: 'A study in motion'},
  particle: {number: '02', label: 'PARTICLE', concept: 'A thousand possibilities'},
  organic: {number: '03', label: 'ORGANIC', concept: 'Something comes alive'},
  abstract: {number: '04', label: 'ABSTRACT', concept: 'Reality, rearranged'},
};

export interface GenerateRequest {
  imageBase64: string;
  worldId: WorldId;
}

export interface GenerateResponse {
  code: string;
  fullResponse: string;
}

export function createWorlds(status: WorldStatus = 'idle', revision = 0): WorldOutput[] {
  return WORLD_IDS.map((id) => ({id, status, code: '', fullResponse: '', error: null, revision}));
}
