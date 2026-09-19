import {copyFile, mkdir, readdir, stat, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const vision = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const target = path.join(root, 'public', 'mediapipe');
const vendor = path.join(root, 'public', 'vendor');
await mkdir(path.join(target, 'wasm'), {recursive: true});
await mkdir(vendor, {recursive: true});
await copyFile(path.join(root, 'node_modules', 'p5', 'lib', 'p5.min.js'), path.join(vendor, 'p5.min.js'));
await copyFile(path.join(vision, 'vision_bundle.js'), path.join(target, 'vision_bundle.js'));
for (const file of await readdir(path.join(vision, 'wasm'))) {
  if (/\.(wasm|js)$/.test(file)) await copyFile(path.join(vision, 'wasm', file), path.join(target, 'wasm', file));
}

const modelPath = path.join(target, 'hand_landmarker.task');
const existing = await stat(modelPath).catch(() => null);
if (!existing || existing.size < 1_000_000) {
  console.info('Preparing the local MediaPipe hand model (first run only)…');
  try {
    const response = await fetch('https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', {
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error('Model download failed.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1_000_000 || buffer.length > 20_000_000) throw new Error('Invalid model download.');
    await writeFile(modelPath, buffer);
  } catch {
    console.warn('Hand model is unavailable. The app can still start. Connect to the internet and run npm run setup:assets, then retry hand tracking.');
    if (process.argv.includes('--required')) process.exitCode = 1;
  }
}
console.info('Local p5.js and MediaPipe runtime assets are ready.');
