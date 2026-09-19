import {GoogleGenAI, ThinkingLevel, type ThinkingConfig} from '@google/genai';
import {Script} from 'node:vm';
import ts from 'typescript';
import {WORLD_IDS, type WorldId} from '../lib/worlds.ts';
import {buildWorldPrompt} from './prompts.ts';
import {providerDiagnostic} from './providerDiagnostic.ts';

// 2.5 Flash can be listed while rejecting new API projects. This stable default
// was verified with the image-to-code prompt; GEMINI_MODEL can still override it.
export const DEFAULT_MODEL = 'gemini-3.6-flash';
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024;
export const MAX_RESPONSE_CHARS = 120_000;

const PUBLIC_ERRORS = {
  invalid_body: {status: 400, error: 'Send a JSON snapshot and a valid worldId.'},
  invalid_world: {status: 400, error: 'Choose physics, particle, organic, or abstract.'},
  invalid_image: {status: 400, error: 'Capture a valid JPEG, PNG, or WebP snapshot and try again.'},
  image_too_large: {status: 413, error: 'The snapshot is too large. Capture an image smaller than 4 MB.'},
  unsupported_type: {status: 415, error: 'Send the snapshot as application/json.'},
  body_timeout: {status: 408, error: 'The snapshot upload timed out. Please capture again.'},
  unconfigured: {status: 503, error: 'GEMINI_API_KEY is not configured on the local server. Check .env.local and restart.'},
  capacity: {status: 503, error: 'Other worlds are still generating. Wait a moment and retry this frame.'},
  timeout: {status: 504, error: 'This world took too long to generate. Retry this frame.'},
  cancelled: {status: 499, error: 'Generation was cancelled.'},
  invalid_code: {status: 422, error: 'Gemini returned an incomplete sketch. Retry this frame.'},
  empty_response: {status: 422, error: 'Gemini did not return a sketch for this scene. Retry this frame or capture another scene.'},
  response_too_large: {status: 422, error: 'Gemini returned an oversized sketch. Retry this frame.'},
  credentials: {status: 502, error: 'Gemini rejected the server credentials. Check the existing .env.local configuration and restart.'},
  quota: {status: 429, error: 'Gemini quota or rate limit reached. Wait a little, then retry this frame.'},
  model: {status: 502, error: 'The configured Gemini model is unavailable. Check GEMINI_MODEL on the local server.'},
  model_access: {status: 502, error: 'This Gemini model is unavailable to new API users. Choose a current model with GEMINI_MODEL and restart.'},
  unavailable: {status: 502, error: 'Gemini is temporarily unavailable. Check your connection and retry this frame.'},
} as const;

export type GenerationErrorCode = keyof typeof PUBLIC_ERRORS;

/** Only these fixed messages may cross the server boundary. */
export class GenerationError extends Error {
  code: GenerationErrorCode;

  constructor(code: GenerationErrorCode) {
    super(PUBLIC_ERRORS[code].error);
    this.name = 'GenerationError';
    this.code = code;
  }
}

export interface ValidatedGenerationRequest {
  worldId: WorldId;
  image: {data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'};
}

function hasImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 16 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  if (mimeType === 'image/png') {
    return bytes.length >= 33 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR';
  }
  return bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8;
}

export function validateGenerationRequest(value: unknown): ValidatedGenerationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GenerationError('invalid_body');
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.worldId !== 'string' || !WORLD_IDS.includes(payload.worldId as WorldId)) {
    throw new GenerationError('invalid_world');
  }
  if (typeof payload.imageBase64 !== 'string') throw new GenerationError('invalid_image');
  if (payload.imageBase64.length > MAX_BODY_BYTES - 256) throw new GenerationError('image_too_large');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(payload.imageBase64);
  if (!match || match[2].length % 4 !== 0) throw new GenerationError('invalid_image');
  const [, mimeType, data] = match;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new GenerationError('image_too_large');
  if (bytes.toString('base64') !== data || !hasImageSignature(bytes, mimeType)) {
    throw new GenerationError('invalid_image');
  }
  return {worldId: payload.worldId as WorldId, image: {data, mimeType: mimeType as ValidatedGenerationRequest['image']['mimeType']}};
}

/** Parse the syntax, never execute model output on the server. This is not a sandbox. */
export function validateSketchCode(code: string): boolean {
  if (!code.trim() || code.length > MAX_RESPONSE_CHARS) return false;
  try {
    new Script(code, {filename: 'generated-sketch.js'});
  } catch {
    return false;
  }
  const source = ts.createSourceFile('generated-sketch.js', code, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS);
  const callbacks = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body &&
        !statement.asteriskToken && !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      callbacks.add(statement.name.text);
    }
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
      const expression = statement.expression;
      if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
          !(ts.isFunctionExpression(expression.right) || ts.isArrowFunction(expression.right))) continue;
      const left = expression.left;
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) &&
          (left.expression.text === 'window' || left.expression.text === 'globalThis')) {
        callbacks.add(left.name.text);
      }
    }
  }
  return callbacks.has('setup') && callbacks.has('draw');
}

/** Preserve the reference project's fenced-JavaScript extraction, with validation. */
export function extractSketchCode(response: string): string {
  if (typeof response !== 'string' || !response.trim()) throw new GenerationError('empty_response');
  if (response.length > MAX_RESPONSE_CHARS) throw new GenerationError('response_too_large');
  const blocks: string[] = [];
  const fences = /```[ \t]*([^\r\n`]*)\r?\n([\s\S]*?)```/g;
  for (const match of response.matchAll(fences)) {
    if (/^(?:javascript|js|p5(?:\.?js)?)?$/i.test(match[1].trim())) {
      blocks.push(match[2].trim());
    }
  }
  const complete = blocks.filter(validateSketchCode);
  // Separate helper/setup/draw blocks belong together; multiple complete variants
  // should not be concatenated into duplicate declarations. Prefer the last one.
  const candidates = complete.length > 1
    ? [...complete].reverse()
    : blocks.length > 0 ? [blocks.join('\n\n'), ...complete] : [response.trim()];
  for (const code of candidates) {
    if (validateSketchCode(code)) return code;
  }
  throw new GenerationError('invalid_code');
}

/** Do not expose SDK messages, response bodies, URLs, keys, or stack traces. */
export function publicGenerationError(error: unknown): {status: number; error: string} {
  if (error instanceof GenerationError) return {...PUBLIC_ERRORS[error.code]};
  const upstream = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = Number(upstream.status ?? upstream.statusCode ?? upstream.code);
  const message = typeof upstream.message === 'string' ? upstream.message : '';
  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message)) return {...PUBLIC_ERRORS.quota};
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid|UNAUTHENTICATED|PERMISSION_DENIED/i.test(message)) {
    return {...PUBLIC_ERRORS.credentials};
  }
  if (status === 404 && /(?:no longer |not )available to new users/i.test(message)) return {...PUBLIC_ERRORS.model_access};
  if (status === 404) return {...PUBLIC_ERRORS.model};
  if (status === 408 || status === 504 || upstream.name === 'TimeoutError') return {...PUBLIC_ERRORS.timeout};
  if (upstream.name === 'AbortError') return {...PUBLIC_ERRORS.cancelled};
  return {...PUBLIC_ERRORS.unavailable};
}

export type GenerateSketch = (request: ValidatedGenerationRequest, signal: AbortSignal) => Promise<string>;

export function thinkingConfigForModel(model: string): ThinkingConfig | undefined {
  // LOW is supported by the 3.x general-purpose Flash family. Do not send it to
  // 2.5 models (thinkingBudget only) or image variants with different capabilities.
  return /^(?:models\/)?gemini-3(?:\.\d+)?-flash(?:-preview(?:-\d{2}-\d{2})?)?$/.test(model)
    ? {thinkingLevel: ThinkingLevel.LOW}
    : undefined;
}

export function createGeminiGenerator(apiKey: string, model: string, timeoutMs: number): GenerateSketch {
  // Constructed only on the server; no credentials are placed in prompts or URLs.
  const ai = new GoogleGenAI({apiKey, vertexai: false});
  return async (request, signal) => {
    const result = await ai.models.generateContent({
      model,
      contents: [{role: 'user', parts: [
        {text: 'Interpret this one captured scene as the assigned interactive world.'},
        {inlineData: request.image},
      ]}],
      config: {
        systemInstruction: buildWorldPrompt(request.worldId),
        temperature: 1.05,
        maxOutputTokens: 8192,
        thinkingConfig: thinkingConfigForModel(model),
        abortSignal: signal,
        httpOptions: {timeout: timeoutMs, retryOptions: {attempts: 1}},
      },
    }).catch((error: unknown) => {
      const diagnostic = providerDiagnostic(error);
      if (diagnostic.code !== 'CANCELLED') {
        // This contains only a validated world id, an HTTP number, and fixed enums.
        console.warn('[Gemini generation failed]', {worldId: request.worldId, ...diagnostic});
      }
      throw error;
    });
    return result.text ?? '';
  };
}
