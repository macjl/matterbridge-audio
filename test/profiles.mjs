import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ControllerBehavior, Environment, Logger, LogLevel, ServerNode } from 'matterbridge/matter';
import { ContentLauncherClient, MediaPlaybackClient } from 'matterbridge/matter/behaviors';
import { ContentLauncher } from 'matterbridge/matter/clusters';
import { createRecord, readRecord, cataloguePage } from '/usr/local/lib/node_modules/matterbridge-securitysystem-audio/profiles.js';
import { defaults } from '/usr/local/lib/node_modules/matterbridge-securitysystem-audio/player.js';
const base = 'http://127.0.0.1:45804/plugins/';
Logger.level = LogLevel.ERROR;
async function api(plugin, action = 'status', fields = {}) {
  const send = () => fetch(base + plugin + '/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields), signal: AbortSignal.timeout(12000) });
  let response = await send();
  if (response.status === 401) {
    const login = await fetch(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '' }) });
    assert.equal((await login.json()).valid, true); response = await send();
  }
  return response.json();
}
async function alarm(action = 'status', fields) { const r = await api('matterbridge-securitysystem-core', action, fields); assert.ifError(r.error); return r; }
async function audio(action = 'status', fields) { const r = await api('matterbridge-securitysystem-audio', action, fields); assert.ifError(r.error); return r; }
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  let error;
  do { try { const r = await fn(); if (r) return r; } catch (e) { error = e; } await delay(100); } while (Date.now() < end);
  throw new Error('Timeout : ' + label, { cause: error });
}
const files = () => readdirSync('/test/captures').filter((n) => n.endsWith('.pcm')).sort();
const latest = () => '/test/captures/' + files().at(-1);
const rms = (file, begin, end) => {
  const data = readFileSync(file); let count = 0, sum = 0;
  for (let i = Math.floor(begin * 48000); i < Math.min(data.length / 2, end * 48000); i++) { sum += data.readInt16LE(i * 2) ** 2; count++; }
  return Math.sqrt(sum / count);
};
const nodes = [];
try {
  const migrated = readRecord({ ...defaults, volume: 60 });
  assert.equal(migrated.profiles[0].volume, 60);
  assert.equal(migrated.selectedId, 'default');
  await until(async () => (await api('matterbridge-securitysystem-audio').catch(() => ({}))).profiles, 'startup');
  const initial = await audio();
  assert.equal(initial.state, 'stopped');
  assert.deepEqual(initial.profiles.map((p) => p.name), ['Défaut', 'Pré-armement', 'Préalarme', 'Alarme']);
  assert.match(await (await fetch(base + 'matterbridge-securitysystem-audio/')).text(), /Profils sonores/);
  assert.ok((await api('matterbridge-securitysystem-audio', 'profile', { profile: { name: 'bad' } })).error);
  Environment.default.vars.set('path.root', mkdtempSync('/tmp/named-profiles-home-'));
  const home = await ServerNode.create(ServerNode.RootEndpointWithoutGroupcast.with(ControllerBehavior), { id: 'named-profiles-test', commissioning: { enabled: false }, network: { port: 0 } });
  nodes.push(home); await home.start();
  const ip = Object.values(networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal).address;
  const bridge = await home.peers.forDescriptor({ addresses: [{ type: 'udp', ip, port: 45803 }] });
  await bridge.commission({ pairingCode: readFileSync('/test/bridge-code', 'utf8').trim(), autoSubscribe: true });
  const endpoint = bridge.endpoints.find((e) => e.number === initial.endpoints.player);
  assert.ok(endpoint.maybeStateOf(ContentLauncherClient));
  await alarm('pair-device', { code: (await bridge.openEnhancedCommissioningWindow()).manualPairingCode });
  const self = await until(async () => (await alarm('status', { refreshProfiles: true })).peers.find((p) => p.connected && p.endpoints.some((e) => e.commands.some((c) => c.id === 'profile' && c.choices.length === 4))), 'catalogue self-pair');
  const player = self.endpoints.find((e) => e.number === initial.endpoints.player);
  assert.deepEqual(player.commands.find((c) => c.id === 'profile').choices.map((p) => p.label), initial.profiles.map((p) => p.name));
  assert.equal((await audio()).state, 'stopped');
  assert.equal(files().length, 0, 'catalogue discovery is silent');
  const values = { sound: 'beep', volume: 20, loop: true, seconds: 0 };
  await audio('profile', { profile: { name: 'Préalarme essai', ...values } });
  const entry = (await audio()).profiles.at(-1);
  assert.match((await api('matterbridge-securitysystem-audio', 'profile', { profile: { name: ' PRÉALARME ESSAI ', ...values } })).error, /déjà/);
  await audio('profile', { profile: { name: 'Sirène essai', sound: 'alarm', volume: 40, loop: true, seconds: 1 } });
  const loud = (await audio()).profiles.at(-1);
  await alarm('status', { refreshProfiles: true });
  const op = (id) => ({ peer: self.id, endpoint: player.number, command: 'profile', value: id });
  const action = async (name, operations) => (await alarm('action', { name, operations })).alarm.actions.at(-1);
  const entryAction = await action('Profil préalarme', [op(entry.id)]);
  const alarmAction = await action('Profil alarme', [op(loud.id)]);
  const stop = await action('Couper le lecteur', [{ peer: self.id, endpoint: player.number, command: 'stop' }]);
  async function test(item, fail = false) {
    const at = Date.now(); await alarm('test-action', { id: item.id });
    const done = await until(async () => { const r = await alarm(); return !r.actionRunning && !r.alarm.pendingActions.length && r; }, item.name);
    const events = done.alarm.history.filter((e) => e.at >= at && e.message.includes(' · ' + item.name + ' · '));
    assert.equal(events.length, item.operations.length);
    assert.equal(events.some((e) => e.message.startsWith('Échec')), fail);
  }
  await test(entryAction);
  await until(() => files().length === 1 && statSync(latest()).size > 110000, 'beep capture');
  const beep = latest();
  assert.equal((await audio()).selectedId, entry.id);
  assert.equal((await audio()).settings.volume, 20);
  await test(alarmAction);
  assert.equal((await audio()).selectedId, loud.id);
  assert.equal((await audio()).settings.volume, 40);
  await until(async () => (await audio()).state === 'stopped', 'alarm natural end');
  const size = statSync(beep).size; await delay(250); assert.equal(statSync(beep).size, size, 'previous profile terminated');
  assert.ok(rms(beep, .01, .09) > 450); assert.equal(rms(beep, .2, .8), 0);
  assert.ok(rms(latest(), .1, .8) > 900);
  console.log('Profils : catalogue Matter silencieux, volumes appliqués, bips/sirène PCM, remplacement et fin naturelle validés.');

  await test(entryAction);
  await endpoint.commandsOf(MediaPlaybackClient).pause();
  assert.equal((await audio()).state, 'paused');
  await test(alarmAction);
  assert.equal((await audio()).state, 'playing', 'new profile starts despite paused previous profile');
  await test(stop);
  await audio('profile', { profile: { ...entry, name: 'Préalerte renommée' } });
  await alarm('status', { refreshProfiles: true });
  await test(entryAction);
  assert.equal((await audio()).selectedId, entry.id);
  assert.equal((await audio()).events[0].profile, 'Préalerte renommée');
  assert.match((await api('matterbridge-securitysystem-audio', 'remove-profile', { id: entry.id })).error, /Arrête/);
  await test(stop);
  await audio('remove-profile', { id: entry.id });
  await test(entryAction, true);
  console.log('Identifiant stable au renommage, remplacement d’une pause, suppression et refus d’un profil absent validés.');

  for (let i = 0; i < 18; i++) await audio('profile', { profile: { name: `Profil catalogue ${String(i).padStart(2, '0')} abcdefghijklmn`, ...values } });
  const long = await alarm('status', { refreshProfiles: true });
  const choices = long.peers.find((p) => p.id === self.id).endpoints.find((e) => e.number === player.number).commands.find((c) => c.id === 'profile').choices;
  assert.equal(choices.length, (await audio()).profiles.length);
  const generated = createRecord();
  generated.profiles = (await audio()).profiles;
  assert.ok(cataloguePage(generated).next !== null);
  assert.ok(Buffer.byteLength(JSON.stringify(cataloguePage(generated))) <= 800);
  console.log('Catalogue paginé : tous les profils découverts sans dépasser une réponse Matter courte.');

  await audio('select-profile', { id: loud.id });
  assert.equal((await audio()).state, 'stopped');
  const before = await audio();
  writeFileSync('/test/restart', '');
  await until(() => existsSync('/test/restarted'), 'restart', 30000);
  await until(async () => (await api('matterbridge-securitysystem-audio').catch(() => ({}))).profiles, 'restart API');
  const after = await audio();
  assert.deepEqual(after.profiles, before.profiles);
  assert.equal(after.selectedId, loud.id);
  assert.equal(after.state, 'stopped');
  assert.deepEqual(after.endpoints, before.endpoints);
  await until(async () => (await alarm('status', { refreshProfiles: true })).peers.find((p) => p.id === self.id && p.connected), 'existing self-pair restored', 30000);
  await test(alarmAction); await test(stop);
  console.log('Redémarrage : profils, sélection et numéros conservés, aucune reprise sonore, actions encore fonctionnelles.');
} finally {
  await api('matterbridge-securitysystem-audio', 'stop').catch(() => {});
  for (const node of nodes.reverse()) await node.close().catch(() => {});
}
