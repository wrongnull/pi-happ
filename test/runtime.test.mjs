import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { releaseFor, extractBinary, ensureRuntime, downloadArchive } from '../src/runtime.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
test('release selection is pinned and rejects unsupported hosts', () => {
  assert.equal(releaseFor('linux', 'x64').asset, 'Xray-linux-64.zip');
  assert.equal(releaseFor('linux', 'arm64').sha256.length, 64);
  assert.throws(() => releaseFor('darwin', 'arm64'), /PI_HAPP_XRAY/);
  assert.throws(() => releaseFor('linux', 'ia32'));
});
test('verify SHA-256 before extracting only the binary (no archive paths written)', () => {
  const zip = zipSync({ xray: strToU8('synthetic binary'), '../untrusted': strToU8('ignored') });
  assert.equal(Buffer.from(extractBinary(zip, digest(zip))).toString(), 'synthetic binary');
  assert.throws(() => extractBinary(zip, '0'.repeat(64)), /SHA-256/);
  const empty = zipSync({ 'other-file': strToU8('ignored') });
  assert.throws(() => extractBinary(empty, digest(empty)), /no usable binary/);
});
test('failed integrity does not install and concurrent attempts share one download', async () => {
  let downloads = 0;
  const options = { root: '/tmp/pi-happ-integrity-test-never-created', platform: 'linux', arch: 'x64',
    download: async () => { downloads++; return Buffer.from('corrupted'); } };
  const results = await Promise.allSettled([ensureRuntime(options), ensureRuntime(options)]);
  assert.ok(results.every(r => r.status === 'rejected' && /SHA-256/.test(r.reason.message)));
  assert.equal(downloads, 1);
});
test('downloader rejects HTTP errors', async () => {
  await assert.rejects(downloadArchive('https://example.invalid', async () => new Response('', { status: 403 })), /download failed/);
});
