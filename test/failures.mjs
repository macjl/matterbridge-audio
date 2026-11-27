import assert from 'node:assert/strict';
import { Player, defaults } from '/usr/local/lib/node_modules/matterbridge-audio-poc/player.js';

const unavailable = new Player({ ...defaults, device: 'invalid_audio_device' });
await assert.rejects(unavailable.play(), /Unknown PCM|audio|ALSA|Invalid/i);
assert.equal(unavailable.state, 'stopped');
assert.ok(unavailable.error);
assert.equal(unavailable.child, undefined);
await unavailable.close();

const missing = new Player({ ...defaults });
process.env.PATH = '/no-binary-here';
await assert.rejects(missing.play(), /ENOENT/);
assert.equal(missing.state, 'stopped');
assert.equal(missing.child, undefined);
await missing.close();
console.log('Erreurs ALSA et FFmpeg absent : Play échoue, aucun faux état de lecture ni processus restant.');
