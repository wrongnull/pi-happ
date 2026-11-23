import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const action of ['Select location', 'Check location latency (TCP)']) {
  for (const succeeds of [true, false]) {
    test(`${action}: selecting a result connects; ${succeeds ? 'success closes menu' : 'failure does not announce success'}`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'pi-happ-connect-ui-'));
      try {
        const config = join(home, '.config', 'pi-happ');
        await mkdir(config, { recursive: true });
        await writeFile(join(config, 'subscriptions.json'), JSON.stringify({ version: 1, subscriptions: [
          { id: 'test', name: 'Test', url: 'https://example.invalid', updatedAt: '', profiles: [
            { remarks: 'First', outbounds: [{ protocol: 'hysteria' }] },
            { remarks: 'Second', outbounds: [{ protocol: 'hysteria' }] },
          ] },
        ] }));
        const source = `
          import extension from ${JSON.stringify(new URL('../src/extension.ts', import.meta.url).href)};
          import { Tunnel } from ${JSON.stringify(new URL('../src/core.mjs', import.meta.url).href)};
          const attempts = [];
          Tunnel.prototype.start = async function(profile) {
            attempts.push(profile.remarks);
            if (!${succeeds}) throw new Error('synthetic connection failure');
            this.child = { exitCode: null, signalCode: null };
            this.label = profile.remarks;
          };
          Tunnel.prototype.checkIP = async () => ({ ip: '203.0.113.1', latencyMs: 12 });
          Tunnel.prototype.stop = async function() { this.child = undefined; };
          const commands = new Map(); const events = new Map(); const notices = [];
          extension({ registerProvider() {}, registerCommand(name, command) { commands.set(name, command); }, on(name, fn) { events.set(name, fn); } });
          let menuVisits = 0; let aborts = 0; let status;
          const ctx = { hasUI: true, mode: 'rpc', abort() { aborts++; }, ui: {
            notify(message, level) { notices.push({ message, level }); }, setStatus(_name, value) { status = value; },
            async select(title, items) {
              if (title.startsWith('Happ')) return ++menuVisits === 1 ? ${JSON.stringify(action)} : 'Close';
              if (title === 'Subscriptions') return items[0];
              if (title.startsWith('Location') || title.startsWith('TCP latency results')) return items[1];
              throw new Error('Unexpected dialog');
            }
          } };
          await commands.get('happ').handler('', ctx);
          const visitsAfterConnect = menuVisits;
          const statusAfterConnect = status;
          // The menu command must be usable again (busy flag cleared in finally).
          await commands.get('happ').handler('', ctx);
          await events.get('session_shutdown')();
          console.log(JSON.stringify({ attempts, notices, aborts, visitsAfterConnect, menuVisits, statusAfterConnect }));
        `;
        const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
          encoding: 'utf8', env: { ...process.env, HOME: home, LC_ALL: 'C' }, timeout: 10000,
        }));
        assert.deepEqual(result.attempts, ['Second']);
        assert.equal(result.aborts, 1);
        assert.equal(result.visitsAfterConnect, 1);
        assert.equal(result.menuVisits, 2);
        assert.equal(result.notices.some(n => n.message.startsWith('VPN ready:')), succeeds);
        if (succeeds) {
          assert.equal(result.statusAfterConnect, 'Happ: Second');
          assert.ok(!result.notices.some(n => n.level === 'error'));
        } else {
          assert.ok(result.notices.some(n => n.level === 'error' && n.message === 'synthetic connection failure'));
        }
      } finally { await rm(home, { recursive: true, force: true }); }
    });
  }
}
