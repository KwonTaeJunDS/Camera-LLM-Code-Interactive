import type {IncomingHttpHeaders, IncomingMessage, ServerResponse} from 'node:http';
import {loadEnv, type Connect, type Plugin} from 'vite';
import {
  createGeminiGenerator, DEFAULT_MODEL, extractSketchCode, GenerationError,
  MAX_BODY_BYTES, publicGenerationError, validateGenerationRequest,
  type GenerateSketch,
} from './generation.ts';

const REQUEST_TIMEOUT_MS = 90_000;
const BODY_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT = 8;

/** Loopback host validation also prevents DNS rebinding against the local API. */
export function isAllowedLocalRequest(headers: IncomingHttpHeaders, secure = false): boolean {
  const host = headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return false;
  const site = headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = headers.origin;
  if (origin === undefined) return true; // CLI health checks and same-origin GETs.
  if (origin === 'null') return false; // Sandboxed generated sketches have opaque origins.
  try {
    const expected = new URL(`${secure ? 'https' : 'http'}://${host}`).origin;
    return new URL(origin).origin === origin && origin === expected;
  } catch {
    return false;
  }
}

function respond(res: ServerResponse, status: number, body: object): void {
  if (res.writableEnded || res.destroyed) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(json);
}

function readJson(req: IncomingMessage, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) {
    return Promise.reject(new GenerationError('unsupported_type'));
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    return Promise.reject(new GenerationError('image_too_large'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => fail(new GenerationError('body_timeout')), timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      req.resume(); // Discard unread bytes without keeping an oversized body in memory.
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(new GenerationError('image_too_large'));
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new GenerationError('invalid_body'));
      }
      chunks.length = 0;
    };
    const onError = () => fail(new GenerationError('invalid_body'));
    const onAbort = () => fail(signal.reason ?? new GenerationError('cancelled'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    signal.addEventListener('abort', onAbort, {once: true});
    if (signal.aborted) onAbort();
  });
}

/** Bound waiting even if an upstream implementation is slow to honor AbortSignal. */
async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new GenerationError('cancelled'));
    signal.addEventListener('abort', onAbort, {once: true});
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export interface GenerationMiddlewareOptions {
  apiKey?: string;
  model?: string;
  /** Dependency injection permits full HTTP tests without sending an image or key. */
  generate?: GenerateSketch;
  timeoutMs?: number;
  bodyTimeoutMs?: number;
  maxConcurrent?: number;
}

export function createGenerationMiddleware(options: GenerationMiddlewareOptions): Connect.NextHandleFunction {
  const apiKey = options.apiKey?.trim() ?? '';
  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? BODY_TIMEOUT_MS;
  const maxConcurrent = Math.max(1, Math.min(MAX_CONCURRENT, options.maxConcurrent ?? MAX_CONCURRENT));
  const generate = options.generate ?? (apiKey ? createGeminiGenerator(apiKey, model, timeoutMs) : undefined);
  let activeRequests = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse, route: string) => {
    const secure = 'encrypted' in req.socket && Boolean(req.socket.encrypted);
    if (!isAllowedLocalRequest(req.headers, secure)) {
      respond(res, 403, {error: 'This API accepts requests from this local app only.'});
      req.resume();
      return;
    }
    const method = route === '/api/health' ? 'GET' : 'POST';
    if (req.method !== method) {
      res.setHeader('Allow', method);
      respond(res, 405, {error: `Use ${method} for this endpoint.`});
      req.resume();
      return;
    }
    if (route === '/api/health') {
      respond(res, 200, {configured: Boolean(apiKey), model});
      return;
    }
    if (activeRequests >= maxConcurrent) {
      res.setHeader('Retry-After', '5');
      const error = publicGenerationError(new GenerationError('capacity'));
      respond(res, error.status, {error: error.error});
      req.resume();
      return;
    }

    activeRequests += 1;
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort(new GenerationError('cancelled'));
    };
    req.once('aborted', cancel);
    res.once('close', cancel);
    const timer = setTimeout(() => controller.abort(new GenerationError('timeout')), timeoutMs);
    timer.unref();
    try {
      const request = validateGenerationRequest(await readJson(req, controller.signal, bodyTimeoutMs));
      if (!apiKey || !generate) throw new GenerationError('unconfigured');
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await withAbort(generate(request, controller.signal), controller.signal);
      // Credentials never enter the prompt, but redact an exact match defensively.
      const fullResponse = response.split(apiKey).join('[REDACTED]');
      const code = extractSketchCode(fullResponse);
      respond(res, 200, {code, fullResponse});
    } catch (error) {
      const safe = publicGenerationError(error);
      if (safe.status === 429) res.setHeader('Retry-After', '30');
      respond(res, safe.status, {error: safe.error});
      req.resume();
    } finally {
      clearTimeout(timer);
      req.off('aborted', cancel);
      res.off('close', cancel);
      activeRequests -= 1;
    }
  };

  return (req, res, next) => {
    const route = req.url?.split('?')[0];
    if (route !== '/api/generate' && route !== '/api/health') return next();
    void handle(req, res, route).catch(() => {
      // No SDK/HTTP error object is logged or serialized, even for unexpected failures.
      respond(res, 500, {error: 'The local generation server could not complete this request.'});
    });
  };
}

export function generationApiPlugin(): Plugin {
  let middleware: Connect.NextHandleFunction;
  return {
    name: 'local-gemini-generation-api',
    configResolved(config) {
      // Prefix filtering keeps unrelated environment variables out of this layer.
      // In particular, never return these values through Vite's client `define`.
      const env = loadEnv(config.mode, config.envDir, 'GEMINI_');
      middleware = createGenerationMiddleware({apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL});
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
