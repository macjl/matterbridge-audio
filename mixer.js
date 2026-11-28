import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function controlDevice(output) {
  if (output === 'default' || output === 'sysdefault') return 'default';
  const card = /(?:^|[:,])CARD=([a-zA-Z0-9_-]+)(?:,|$)/.exec(output)?.[1]
    ?? /^(?:plug)?hw:([a-zA-Z0-9_-]+)(?:,|$)/.exec(output)?.[1];
  return card ? 'hw:' + card : null;
}

async function master(output, command, args = []) {
  const device = controlDevice(output);
  if (!device) throw new Error('La sortie sélectionnée n’expose pas de mixeur Master.');
  const { stdout } = await exec('amixer', ['-M', '-D', device, command, 'Master', ...args], {
    env: { ...process.env, LC_ALL: 'C' }, timeout: 1200, maxBuffer: 8192,
  });
  // A mono control produces one line, and stereo controls report one per channel.
  const channels = stdout.split('\n').flatMap((line) => {
    const level = /\bPlayback -?\d+ \[(\d+)%\]/.exec(line);
    return level ? [{ volume: Number(level[1]), muted: line.includes('[off]') }] : [];
  });
  if (!channels.length) throw new Error('Le mixeur Master ne retourne aucun volume de lecture.');
  return { volume: Math.max(...channels.map(({ volume }) => volume)), muted: channels.every(({ muted }) => muted) };
}

export async function outputVolume(output) {
  try { return await master(output, 'sget'); }
  catch { return null; }
}

export async function setOutputVolume(output, volume) {
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('Choisis un volume de sortie entre 0 et 100 %.');
  try { return await master(output, 'sset', ['playback', volume + '%', volume === 0 ? 'mute' : 'unmute']); }
  catch (error) {
    throw new Error('Impossible de régler le mixeur Master de la sortie audio.', { cause: error });
  }
}

export async function setOutputMute(output, muted) {
  try { return await master(output, 'sset', ['playback', muted ? 'mute' : 'unmute']); }
  catch (error) {
    throw new Error('Impossible de régler le mixeur Master de la sortie audio.', { cause: error });
  }
}
