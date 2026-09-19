// Explicit opt-in smoke test: sends one synthetic illustration to Gemini for
// each of four worlds. No camera, personal image, or credential is read here.
import {deflateSync} from 'node:zlib';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

if (!process.argv.includes('--run')) {
  console.info('Run with --run while npm run dev is running. This makes four real Gemini generation requests using a synthetic test image.');
  process.exit(0);
}

const outputDir = fileURLToPath(new URL('../test-results/', import.meta.url));
await mkdir(outputDir, {recursive: true});
const width = 640;
const height = 360;
const pixels = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    let color = [23, 26, 33];
    if ((x - 272) ** 2 / 108 ** 2 + (y - 326) ** 2 / 143 ** 2 < 1) color = [75, 107, 147];
    if ((x - 272) ** 2 + (y - 105) ** 2 < 39 ** 2) color = [225, 178, 144];
    if (x > 255 && x < 289 && y > 132 && y < 178) color = [225, 178, 144];
    if (x > 311 && x < 419 && Math.abs(y - (263 - (x - 311) * 0.43)) < 14) color = [225, 178, 144];
    if ((x - 462) ** 2 + (y - 202) ** 2 < 21 ** 2 && (x - 462) ** 2 + (y - 202) ** 2 > 12 ** 2) color = [223, 174, 89];
    if (x > 398 && x < 457 && y > 171 && y < 235) color = [223, 174, 89];
    if (x > 402 && x < 453 && y > 172 && y < 179) color = [69, 46, 33];
    if (y > 120 && y < 157 && Math.abs(x - 427 - Math.sin(y * .1) * 5) < 2) color = [147, 150, 155];
    const index = y * (width * 3 + 1) + 1 + x * 3;
    pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2];
  }
}

function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const value of payload) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  payload.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
]);
await writeFile(path.join(outputDir, 'synthetic-scene.png'), png);
const imageBase64 = `data:image/png;base64,${png.toString('base64')}`;
const requestedWorld = process.argv.find((arg) => arg.startsWith('--world='))?.slice('--world='.length);
if (requestedWorld && !['physics', 'particle', 'organic', 'abstract'].includes(requestedWorld)) throw new Error('Unknown world name.');
const previous = (process.argv.includes('--retry-failed') || requestedWorld)
  ? JSON.parse(await readFile(path.join(outputDir, 'gemini-smoke.json'), 'utf8')).results : [];
const worldIds = requestedWorld ? [requestedWorld] : ['physics', 'particle', 'organic', 'abstract'].filter((id) => !previous.some((result) => result.worldId === id && result.status === 200));
const started = performance.now();
const results = await Promise.all(worldIds.map(async (worldId) => {
  try {
    const response = await fetch('http://127.0.0.1:3000/api/generate', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({imageBase64, worldId}), signal: AbortSignal.timeout(100_000),
    });
    const result = await response.json();
    if (response.ok && typeof result.code === 'string') {
      await writeFile(path.join(outputDir, `${worldId}.js`), result.code);
    }
    const summary = {worldId, status: response.status, elapsedMs: Math.round(performance.now() - started), codeChars: result.code?.length ?? 0,
      ...(typeof result.error === 'string' ? {error: result.error} : {})};
    console.info(JSON.stringify(summary));
    return summary;
  } catch {
    const summary = {worldId, status: 'network-or-timeout', elapsedMs: Math.round(performance.now() - started), codeChars: 0};
    console.info(JSON.stringify(summary));
    return summary;
  }
}));
await writeFile(path.join(outputDir, 'gemini-smoke.json'), JSON.stringify({syntheticImage: true, retriedFailedOnly: process.argv.includes('--retry-failed'), selectedWorld: requestedWorld,
  results: [...previous.filter((result) => !worldIds.includes(result.worldId)), ...results]}, null, 2));
if (results.some((result) => result.status !== 200)) process.exitCode = 1;
