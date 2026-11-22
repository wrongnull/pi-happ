import { t } from './i18n.mjs';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

export const XRAY_VERSION = '26.11.9';
// Pinned release assets and SHA-256 from XTLS/Xray-core GitHub release metadata.
export const RELEASES = Object.freeze({
  x64: { asset: 'Xray-linux-64.zip', sha256: 'b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82' },
  arm64: { asset: 'Xray-linux-arm64-v8a.zip', sha256: '64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be' },
});
const pending = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const runtimeRoot = join(homedir(), '.local', 'share', 'pi-happ', 'runtimes');

export function releaseFor(platform = process.platform, arch = process.arch) {
  if (platform !== 'linux' || !RELEASES[arch]) {
    throw new Error('Automatic Xray installation supports Linux x64/arm64 only; set PI_HAPP_XRAY for a custom binary');
  }
  return RELEASES[arch];
}

async function cached(directory, release) {
  try {
    const binary = join(directory, 'xray');
    const manifest = JSON.parse(await readFile(join(directory, 'verified.json'), 'utf8'));
    if (manifest.archive !== release.sha256 || hash(await readFile(binary)) !== manifest.binary) return undefined;
    await access(binary, constants.X_OK);
    return binary;
  } catch { return undefined; }
}

export async function downloadArchive(url, fetchFn = globalThis.fetch, signal) {
  signal?.throwIfAborted();
  const response = await fetchFn(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error('Xray download failed');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 80 * 1024 * 1024) throw new Error('Xray archive exceeds 80 MiB limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function extractBinary(archive, sha256) {
  if (hash(archive) !== sha256) throw new Error('Xray SHA-256 verification failed');
  const files = unzipSync(archive, { filter: file => file.name === 'xray' && file.originalSize <= 100 * 1024 * 1024 });
  if (!files.xray?.length) throw new Error('Verified Xray archive contains no usable binary');
  return files.xray;
}

export async function ensureRuntime({ root = runtimeRoot, platform = process.platform, arch = process.arch,
  download = downloadArchive, onProgress = () => {}, signal } = {}) {
  signal?.throwIfAborted();
  const release = releaseFor(platform, arch);
  const directory = join(root, `${XRAY_VERSION}-${platform}-${arch}`);
  if (!signal && pending.has(directory)) return pending.get(directory);
  const task = (async () => {
    const existing = await cached(directory, release);
    signal?.throwIfAborted();
    if (existing) return existing;
    onProgress(t(`Installing Xray ${XRAY_VERSION} (${arch}) from GitHub…`, `Установка Xray ${XRAY_VERSION} (${arch}) с GitHub…`));
    const url = `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/${release.asset}`;
    const archive = await download(url, undefined, signal);
    signal?.throwIfAborted();
    const binary = extractBinary(archive, release.sha256);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(root, '.install-'));
    try {
      await writeFile(join(staging, 'xray'), binary, { mode: 0o700 });
      await chmod(join(staging, 'xray'), 0o700);
      await writeFile(join(staging, 'verified.json'), JSON.stringify({ archive: release.sha256, binary: hash(binary) }), { mode: 0o600 });
      // A second Pi process may have completed the same install in the meantime.
      const concurrent = await cached(directory, release);
      if (concurrent) return concurrent;
      signal?.throwIfAborted();
      try { await rename(staging, directory); }
      catch (error) {
        const concurrent = await cached(directory, release);
        if (concurrent) return concurrent;
        throw new Error('Cannot install Xray cache; remove the damaged version directory and retry', { cause: error });
      }
      return join(directory, 'xray');
    } finally { await rm(staging, { recursive: true, force: true }); }
  })();
  if (!signal) pending.set(directory, task);
  try { return await task; } finally { if (!signal) pending.delete(directory); }
}

export async function resolveRuntime(onProgress, signal) {
  signal?.throwIfAborted();
  if (process.env.PI_HAPP_XRAY) {
    try { await access(process.env.PI_HAPP_XRAY, constants.X_OK); }
    catch { throw new Error('PI_HAPP_XRAY is not an executable file'); }
    return process.env.PI_HAPP_XRAY;
  }
  return ensureRuntime({ onProgress, signal });
}
