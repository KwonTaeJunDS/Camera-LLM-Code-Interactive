import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {generationApiPlugin} from './server/generationPlugin';

// Local-only assets and API calls. This also blocks MediaPipe's optional remote
// telemetry. Inline scripts are needed by Vite and srcDoc; each sketch adds a
// stricter nonce-only policy of its own inside an opaque sandbox.
const headers = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws://127.0.0.1:3000 ws://localhost:3000",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export default defineConfig({
  server: {port: 3000, host: '127.0.0.1', strictPort: true, headers},
  preview: {port: 3000, host: '127.0.0.1', strictPort: true, headers},
  plugins: [react(), generationApiPlugin()],
  resolve: {alias: {'@': path.resolve(import.meta.dirname, '.')}},
  // No secret-bearing define/envPrefix: Gemini is imported exclusively by server/.
});
