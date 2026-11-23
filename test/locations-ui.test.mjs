import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('location menu displays probe results and retains them when reopened', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-happ-locations-ui-'));
  try {
    const config = join(home, '.config', 'pi-happ');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'subscriptions.json'), JSON.stringify({ version: 1, subscriptions: [
      { id: 'test', name: 'Test', url: 'https://example.invalid', updatedAt: '', profiles: [{ remarks: 'UDP-only', outbounds: [{ protocol: 'hysteria' }] }] },
    ] }));
    const source = `
      import extension from ${JSON.stringify(new URL('../src/extension.ts', import.meta.url).href)};
      const commands = new Map(); const events = new Map(); const views = [];
      extension({ registerProvider() {}, registerCommand(name, command) { commands.set(name, command); }, on(name, fn) { events.set(name, fn); } });
      let mainVisits = 0;
      const ctx = { hasUI: true, mode: 'rpc', ui: {
        notify() {}, setStatus() {},
        async select(title, items) {
          if (title.startsWith('Happ')) return ++mainVisits % 2 ? 'Select location' : 'Close';
          if (title === 'Subscriptions') return items[0];
          if (title.startsWith('Location')) { views.push(items); return views.length === 1 ? items[0] : undefined; }
          throw new Error('Unexpected dialog');
        }
      } };
      await commands.get('happ').handler('', ctx);
      await commands.get('happ').handler('', ctx);
      await events.get('session_shutdown')();
      console.log(JSON.stringify(views));
    `;
    const views = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, HOME: home, LC_ALL: 'C' }, timeout: 10000,
    }));
    assert.equal(views.length, 3);
    assert.match(views[0][1], /TCP: —/);
    assert.match(views[1][1], /TCP: n\/a/);
    assert.match(views[2][1], /TCP: n\/a/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
