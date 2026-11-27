import { spawn } from 'node:child_process';

export const sounds = [
  { id: 'beep', name: 'Bip bref toutes les secondes' },
  { id: 'tone', name: 'Tonalité douce' },
  { id: 'alarm', name: 'Sirène' },
];

export const defaults = { sound: 'beep', loop: true, seconds: 10, volume: 25, muted: false, device: 'default' };

export function validateSettings(value) {
  return value && sounds.some(({ id }) => id === value.sound)
    && typeof value.loop === 'boolean' && typeof value.muted === 'boolean'
    && Number.isInteger(value.seconds) && value.seconds >= 0 && value.seconds <= 3600
    && Number.isInteger(value.volume) && value.volume >= 0 && value.volume <= 100
    && typeof value.device === 'string' && /^[a-zA-Z0-9_:,.=-]{1,120}$/.test(value.device);
}

export class Player {
  state = 'stopped';
  error = null;
  child;
  queue = Promise.resolve();
  closed = false;
  revision = 0;

  constructor(settings, changed = () => {}) {
    this.settings = settings;
    this.changed = changed;
  }

  run(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  play() {
    return this.run(async () => {
      if (this.closed) throw new Error('Le lecteur est arrêté.');
      if (this.child && this.state === 'paused') {
        this.child.kill('SIGCONT');
        this.state = 'playing';
        this.changed();
      } else if (!this.child) await this.launch();
    });
  }

  pause() {
    return this.run(() => {
      if (this.child && this.state === 'playing') {
        this.child.kill('SIGSTOP');
        this.state = 'paused';
        this.changed();
      }
    });
  }

  stop() {
    return this.run(async () => {
      await this.terminate();
      this.state = 'stopped';
      this.changed();
    });
  }

  configure(settings) {
    if (!validateSettings(settings)) return Promise.reject(new Error('Réglages audio invalides.'));
    return this.run(async () => {
      if (Object.keys(defaults).every((key) => settings[key] === this.settings[key])) return;
      const state = this.state;
      const restart = Boolean(this.child);
      if (restart) await this.terminate();
      this.settings = { ...settings };
      if (restart) {
        await this.launch();
        if (state === 'paused' && this.child) {
          this.child.kill('SIGSTOP');
          this.state = 'paused';
        }
      }
      this.changed();
    });
  }

  replace(settings, play = true) {
    if (!validateSettings(settings)) return Promise.reject(new Error('Réglages audio invalides.'));
    return this.run(async () => {
      if (this.closed) throw new Error('Le lecteur est arrêté.');
      await this.terminate();
      this.settings = { ...settings };
      this.state = 'stopped';
      this.error = null;
      this.changed();
      if (play) await this.launch();
    });
  }

  async launch() {
    const { sound, loop, seconds, device, volume, muted } = this.settings;
    const beep = sound === 'beep';
    const duration = loop ? '' : ':duration=1';
    const source = beep ? 'sine=frequency=660:sample_rate=48000:duration=0.1'
      : sound === 'tone' ? `sine=frequency=440:sample_rate=48000${duration}`
        : `sine=frequency=880:beep_factor=1.5:sample_rate=48000${duration}`;
    const filters = [];
    if (beep) {
      filters.push('afade=t=in:st=0:d=0.005', 'afade=t=out:st=0.095:d=0.005');
      if (loop) filters.push('apad=whole_dur=1', 'aloop=loop=-1:size=48000');
    }
    filters.push(`volume=${muted ? 0 : volume / 100}`);
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-stats_period', '0.1', '-f', 'lavfi', '-i', source, '-af', filters.join(',')];
    if (seconds > 0) args.push('-t', String(seconds));
    args.push('-f', 'alsa', device);
    this.error = null;
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const revision = ++this.revision;
    this.child = child;
    let stderr = '';
    let failure;
    let started = false;
    let confirm;
    let reject;
    const ready = new Promise((resolve, fail) => { confirm = resolve; reject = fail; });
    let progress = '';
    child.stdout.on('data', (chunk) => {
      progress = (progress + chunk).slice(-2000);
      if (!started && /out_time_us=[1-9][0-9]*/.test(progress)) {
        started = true;
        confirm();
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    const closed = new Promise((resolve) => {
      child.once('error', (error) => { failure = error.message; reject(error); });
      child.once('close', (code, signal) => {
        if (!started) reject(new Error(failure || stderr.trim() || 'FFmpeg est arrêté avant la lecture.'));
        if (this.child === child && this.revision === revision) {
          this.child = undefined;
          this.state = 'stopped';
          if (failure || (code !== 0 && !signal)) this.error = failure || stderr.trim() || `FFmpeg : code ${code}`;
          this.changed();
        }
        resolve();
      });
    });
    child.closed = closed;
    // Acknowledge Play only after FFmpeg has actually written audio to its output.
    const timeout = setTimeout(() => reject(new Error('La sortie audio ne démarre pas (5 s).')), 5000);
    try { await ready; }
    catch (error) {
      this.error = error.message;
      await this.terminate();
      this.state = 'stopped';
      this.changed();
      throw error;
    } finally { clearTimeout(timeout); }
    if (this.child === child) this.state = 'playing';
    this.changed();
  }

  async terminate() {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    ++this.revision;
    child.kill('SIGCONT');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 1500);
    try { await child.closed; }
    finally { clearTimeout(force); }
  }

  async close() {
    this.closed = true;
    await this.stop();
  }
}
