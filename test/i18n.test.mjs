import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLanguage, t, errors } from '../src/i18n.mjs';

test('locale precedence and language fallback', () => {
  for (const locale of ['ru', 'ru_RU.UTF-8', 'ru-RU', 'RU_ru', 'ru_UA', 'ru.UTF-8']) {
    assert.equal(detectLanguage({ LANG: locale }), 'ru');
  }
  for (const locale of ['en_US.UTF-8', 'de_DE', 'C', 'C.UTF-8', 'POSIX', 'russian', '']) {
    assert.equal(detectLanguage({ LANG: locale }), 'en');
  }
  assert.equal(detectLanguage({ LC_ALL: 'C', LC_MESSAGES: 'ru_RU', LANG: 'ru_RU' }), 'en');
  assert.equal(detectLanguage({ LC_ALL: '', LC_MESSAGES: 'ru_RU', LANG: 'en_US' }), 'ru');
  assert.equal(detectLanguage({ LC_ALL: 'ru_RU', LC_MESSAGES: 'en_US' }), 'ru');
  assert.equal(detectLanguage({}), 'en');
});

test('technical errors are translated and unknown errors are preserved', () => {
  for (const [english, russian] of Object.entries(errors)) {
    assert.equal(t(english, undefined, 'en'), english);
    assert.equal(t(english, undefined, 'ru'), russian);
    assert.match(russian, /[а-яё]/i);
  }
  assert.equal(t('external error', undefined, 'ru'), 'external error');
});

for (const locale of ['ru_RU.UTF-8', 'en_US.UTF-8', 'C']) {
  test(`extension menus, commands and IP errors use ${locale}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-happ-locale-'));
    const source = `
      import extension from ${JSON.stringify(new URL('../src/extension.ts', import.meta.url).href)};
      const commands = new Map();
      const events = new Map();
      const output = [];
      extension({ registerProvider() {}, registerCommand(name, options) { commands.set(name, options); }, on(name, fn) { events.set(name, fn); } });
      const ctx = { hasUI: true, mode: 'tui', ui: {
        notify(message) { output.push(message); }, setStatus() {},
        async select(title, items) { output.push(title, ...items); return undefined; }
      } };
      output.push(...[...commands.values()].map(command => command.description));
      await commands.get('happ').handler('', ctx);
      await commands.get('happ-ip-check').handler('', ctx);
      await commands.get('happ-diagnostics').handler('', ctx);
      await events.get('session_shutdown')();
      console.log(JSON.stringify(output));
    `;
    try {
      const text = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8', env: { ...process.env, HOME: home, LC_ALL: locale, LC_MESSAGES: '', LANG: 'ru_RU.UTF-8' }, timeout: 10000,
      });
      const output = JSON.parse(text.trim());
      if (locale.startsWith('ru')) {
        assert.ok(output.includes('Добавить подписку'));
        assert.ok(output.includes('Туннель не запущен'));
      } else {
        assert.ok(output.includes('Add subscription'));
        assert.ok(output.includes('Tunnel is not running'));
        assert.doesNotMatch(output.join('\n'), /[а-яё]/i);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}
