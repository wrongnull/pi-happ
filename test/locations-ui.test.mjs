import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('cancelling latency results does not connect and preserves cached measurements', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-happ-locations-ui-'));
  try {
    const config = join(home, '.config', 'pi-happ');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'subscriptions.json'), JSON.stringify({ version: 1, subscriptions: [
      { id: 'test', name: 'Test', url: 'https://example.invalid', updatedAt: '', profiles: [{ remarks: 'UDP-only', outbounds: [{ protocol: 'hysteria' }] }] },
    ] }));
    const source = `
      import extension from ${JSON.stringify(new URL('../src/extension.ts', import.meta.url).href)};
      const commands = new Map(); const events = new Map(); const views = []; const notices = [];
      extension({ registerProvider() {}, registerCommand(name, command) { commands.set(name, command); }, on(name, fn) { events.set(name, fn); } });
      const steps = ['Select location', 'Check location latency (TCP)', 'Select location', 'Close', 'Select location', 'Close'];
      const ctx = { hasUI: true, mode: 'rpc', abort() { throw new Error('Unexpected attempt to connect'); }, ui: {
        notify(message) { notices.push(message); }, setStatus() {},
        async select(title, items) {
          if (title.startsWith('Happ')) {
            if (!items.includes('Check location latency (TCP)')) throw new Error('Missing main-menu action');
            return steps.shift();
          }
          if (title === 'Subscriptions') return items[0];
          if (title.startsWith('TCP latency results')) { views.push(items); return undefined; }
          if (title.startsWith('Location')) {
            if (items.some(item => item.includes('Check all locations'))) throw new Error('Probe action still in location picker');
            views.push(items); return undefined;
          }
          throw new Error('Unexpected dialog');
        }
      } };
      await commands.get('happ').handler('', ctx);
      await commands.get('happ').handler('', ctx);
      await events.get('session_shutdown')();
      console.log(JSON.stringify({ views, notices }));
    `;
    const { views, notices } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, HOME: home, LC_ALL: 'C' }, timeout: 10000,
    }));
    assert.deepEqual(notices, []);
    assert.equal(views.length, 4);
    assert.match(views[0][0], /TCP: —/);
    for (const view of views.slice(1)) assert.match(view[0], /TCP: n\/a/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
