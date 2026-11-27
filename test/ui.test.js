import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const root = new URL('../apps/frontend/build/', import.meta.url);
async function page(t, state, anonymous = false) {
  const dom = new JSDOM(await readFile(new URL('index.html', root), 'utf8'), { runScripts: 'outside-only', url: 'http://localhost/plugins/plugin/' });
  t.after(() => dom.window.close()); const w = dom.window, requests = [];
  w.setInterval = () => {}; w.confirm = () => true;
  w.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { status: anonymous ? 401 : 200, ok: !anonymous, json: async () => w.JSON.parse(JSON.stringify(anonymous ? { error: 'Unauthorized' } : state)) };
  };
  w.eval(await readFile(new URL('ui.js', root), 'utf8')); w.eval(await readFile(new URL('app.js', root), 'utf8')); await tick();
  return { w, d: w.document, requests };
}
const profile = { id: 'alarm', name: 'Alarme', sound: 'alarm', volume: 60, loop: true, seconds: 0 };
const state = { settings: { ...profile, device: 'default', muted: false }, profiles: [profile], sounds: [{ id: 'alarm', name: 'Sirène' }], selectedId: 'alarm', state: 'stopped', device: 'default', events: [] };
test('audio profiles open in the common navigation; edits keep the Matter identifier', async (t) => {
  const { d, requests } = await page(t, state);
  assert.equal(d.getElementById('controls').hidden, false);
  const edit = Array.from(d.querySelectorAll('#profiles button')).find((b) => b.textContent === 'Modifier'); edit.click();
  assert.equal(d.getElementById('panel-profiles').hidden, false); assert.equal(d.getElementById('profile-editor').open, true);
  const f = d.getElementById('profile-form'); f.elements.name.value = 'Sirène'; f.requestSubmit(); await tick();
  assert.equal(requests.at(-1).body.profile.id, 'alarm'); assert.equal(requests.at(-1).body.profile.name, 'Sirène');
  assert.equal(d.getElementById('profile-editor').open, false); assert.equal(d.getElementById('key'), null);
});
test('unauthenticated audio page asks for native Matterbridge login', async (t) => {
  const { d } = await page(t, state, true); assert.equal(d.getElementById('auth-message').hidden, false);
});
