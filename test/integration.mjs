import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Environment, ControllerBehavior, ServerNode, Logger, LogLevel } from 'matterbridge/matter';
import { BridgedDeviceBasicInformationClient, MediaPlaybackClient, LevelControlClient, OnOffClient, DescriptorClient } from 'matterbridge/matter/behaviors';

const url = 'http://127.0.0.1:46104/plugins/matterbridge-securitysystem-audio/';
Logger.level = LogLevel.ERROR;
async function api(action, fields = {}) {
  const send = () => fetch(url + 'api/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
    signal: AbortSignal.timeout(5000),
  });
  let response = await send();
  if (response.status === 401) {
    const login = await fetch(new URL('/api/login', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '' }) });
    assert.equal((await login.json()).valid, true); response = await send();
  }
  return response.json();
}
async function ok(action, fields) {
  const result = await api(action, fields);
  assert.ifError(result.error);
  return result;
}
async function until(callback, label, timeout = 20000) {
  const end = Date.now() + timeout;
  let error;
  do {
    try { const result = await callback(); if (result) return result; } catch (e) { error = e; }
    await delay(100);
  } while (Date.now() < end);
  throw new Error('Timeout : ' + label, { cause: error });
}
await until(async () => (await fetch(url + 'api/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401, 'anonymous API blocked');
const initial = await until(async () => (await api('status').catch(() => ({}))).settings && ok('status'), 'startup');
assert.equal(initial.state, 'stopped');
assert.equal(initial.playbackState, 2);
assert.match(await (await fetch(url)).text(), /<h1>Audio<\/h1>/);
if (process.env.VERIFY_RESTART) {
  assert.equal(initial.settings.sound, 'tone');
  assert.equal(initial.settings.volume, 25);
  assert.equal(initial.settings.seconds, 0);
  assert.equal(initial.settings.loop, true);
  assert.equal(initial.settings.muted, false);
  console.log('Redémarrage : réglages persistés, lecteur arrêté sans reprise sonore.');
  process.exit(0);
}
const baseProfile = { ...initial.profiles.find(({ id }) => id === initial.selectedId), sound: 'tone', loop: true, seconds: 0, volume: 100 };
const saveSound = (settings = {}) => ok('profile', { profile: { ...baseProfile, ...settings } });
await saveSound();
assert.match((await api('profile', { profile: { ...baseProfile, volume: 101 } })).error, /Vérifie|invalides/);
Environment.default.vars.set('path.root', mkdtempSync('/tmp/audio-fixture-controller-'));
const controller = await ServerNode.create(ServerNode.RootEndpointWithoutGroupcast.with(ControllerBehavior), {
  id: 'audio-poc-test-controller', commissioning: { enabled: false }, network: { port: 0 },
});
const files = () => readdirSync('/test/captures').filter((name) => name.endsWith('.pcm')).sort();
const latest = () => '/test/captures/' + files().at(-1);
const size = (path) => statSync(path).size;
function rms(path, begin = 0, end = Infinity) {
  const data = readFileSync(path);
  let sum = 0, count = 0;
  for (let i = Math.floor(begin * 48000); i < Math.min(data.length / 2, end * 48000); i++) {
    sum += data.readInt16LE(i * 2) ** 2; count++;
  }
  return Math.sqrt(sum / count);
}
try {
  await controller.start();
  const ip = Object.values(networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal).address;
  const peer = await controller.peers.forDescriptor({ addresses: [{ type: 'udp', ip, port: 46103 }] });
  await peer.commission({ pairingCode: readFileSync('/test/bridge-code', 'utf8').trim(), autoSubscribe: true });
  const player = await until(() => peer.endpoints.find((e) => e.maybeStateOf(BridgedDeviceBasicInformationClient)?.nodeLabel === 'Lecteur audio'), 'player');
  const volume = await until(() => peer.endpoints.find((e) => e.number === initial.endpoints.speaker), 'speaker');
  assert.ok(player.stateOf(DescriptorClient).deviceTypeList.some((d) => d.deviceType === 0x28));
  assert.ok(volume.stateOf(DescriptorClient).deviceTypeList.some((d) => d.deviceType === 0x22));
  const media = player.commandsOf(MediaPlaybackClient);
  const levels = volume.commandsOf(LevelControlClient);
  const mute = volume.commandsOf(OnOffClient);
  const state = (value) => until(() => player.stateOf(MediaPlaybackClient).currentState === value, 'Matter playback state ' + value);
  assert.equal((await media.play()).status, 0);
  await state(0);
  await until(() => files().length && size(latest()) > 60000, 'PCM emitted');
  const fullFile = latest();
  await delay(900);
  assert.equal((await media.pause()).status, 0);
  await state(1);
  await delay(200);
  const pausedSize = size(fullFile);
  await delay(500);
  assert.equal(size(fullFile), pausedSize);
  assert.equal((await media.play()).status, 0);
  await state(0);
  await until(() => size(fullFile) > pausedSize, 'resume audio');
  assert.equal(files().length, 1);
  await media.stop();
  await state(2);
  const fullRms = rms(fullFile);
  assert.ok(fullRms > 2000);
  console.log('Commandes Matter réelles : Play, Pause (PCM suspendu), reprise et Stop, états souscrits.');

  await levels.moveToLevel({ level: 64, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
  const audio = await ok('status');
  assert.deepEqual(audio.outputMixer, { volume: 25, muted: false });
  assert.equal(audio.settings.volume, 100);
  await media.play();
  await until(() => files().length >= 2 && size(latest()) > 60000, 'PCM after Master level change');
  const playback = latest();
  await mute.off();
  assert.deepEqual((await ok('status')).outputMixer, { volume: 25, muted: true });
  await mute.on();
  assert.deepEqual((await ok('status')).outputMixer, { volume: 25, muted: false });
  assert.equal(latest(), playback, 'mute is handled by ALSA without replacing FFmpeg');
  await media.stop();
  await state(2);
  const ratio = rms(playback) / fullRms;
  assert.ok(ratio > 0.98 && ratio < 1.02, 'Master acts downstream of PCM generation');
  console.log('Speaker: ALSA output volume and mute preserve the profile and playback process.');

  await saveSound({ sound: 'beep', volume: 25, seconds: 3 });
  await media.play();
  await state(0);
  await state(2);
  const beepFile = latest();
  assert.ok(rms(beepFile, 0.01, 0.09) > 500);
  assert.equal(rms(beepFile, 0.2, 0.8), 0);
  assert.ok(rms(beepFile, 1.01, 1.09) > 500);
  console.log('Bips : 100 ms de son, silence et répétition, arrêt automatique remonté en Matter.');

  await saveSound({ sound: 'beep', loop: false, volume: 25 });
  await media.play();
  await state(2);
  assert.ok(size(latest()) <= 11000);
  const rootPower = player.commandsOf(OnOffClient);
  await rootPower.off();
  assert.equal((await media.play()).status, 2);
  await rootPower.on();

  const originalCount = files().length;
  await saveSound({ volume: 25 });
  await media.play();
  await state(0);
  await media.pause();
  await state(1);
  await media.stop();
  await state(2);
  assert.ok(files().length > originalCount);
  const result = await ok('status');
  assert.ok(result.events.some((e) => e.command === 'MediaPlayback.Play' && e.origin === 'matter'));
  console.log('Arrêt en pause, alimentation et journal des commandes Matter vérifiés.');
} finally {
  await api('stop').catch(() => {});
  await controller.close();
}
