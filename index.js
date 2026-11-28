import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, basicVideoPlayer, speaker, bridgedNode } from 'matterbridge';
import { ContentLauncherServer, FixedLabelServer, MediaPlaybackServer, KeypadInputServer, LevelControlServer, OnOffServer } from 'matterbridge/matter/behaviors';
import { ContentLauncher, FixedLabel, MediaPlayback, KeypadInput, OnOff, LevelControl } from 'matterbridge/matter/clusters';
import { StatusResponse } from 'matterbridge/matter/types';
import { Player, defaults, sounds, validateSettings } from './player.js';
import { outputVolume, setOutputMute, setOutputVolume } from './mixer.js';
import { catalogueFormat, cataloguePage, createRecord, nameKey, profileSettings, readRecord, saveProfile } from './profiles.js';

const bindings = new WeakMap();
const states = { playing: MediaPlayback.PlaybackState.Playing, paused: MediaPlayback.PlaybackState.Paused, stopped: MediaPlayback.PlaybackState.NotPlaying };
const masterVolumeFormat = 'audio-master-volume.v1';
const levelForMixer = (mixer) => mixer ? Math.round(mixer.volume * 254 / 100) : null;

class LocalMediaPlaybackServer extends MediaPlaybackServer {
  async play() {
    if (!this.endpoint.stateOf(OnOffServer).onOff) return { status: MediaPlayback.Status.NotAllowed };
    const plugin = bindings.get(this.endpoint);
    await plugin.enqueue(async () => {
      if (plugin.player.state === 'stopped') {
        await plugin.player.replace(profileSettings(plugin.selectedProfile(), plugin.configRecord.device));
      } else await plugin.player.play();
    });
    this.state.currentState = states[plugin.player.state];
    plugin.record('MediaPlayback.Play', this.context);
    return { status: MediaPlayback.Status.Success };
  }
  async pause() {
    const plugin = bindings.get(this.endpoint);
    await plugin.enqueue(() => plugin.player.pause());
    this.state.currentState = states[plugin.player.state];
    plugin.record('MediaPlayback.Pause', this.context);
    return { status: MediaPlayback.Status.Success };
  }
  async stop() {
    const plugin = bindings.get(this.endpoint);
    await plugin.enqueue(() => plugin.player.stop());
    this.state.currentState = states[plugin.player.state];
    plugin.record('MediaPlayback.Stop', this.context);
    return { status: MediaPlayback.Status.Success };
  }
}

class ProfileContentLauncherServer extends ContentLauncherServer.with('ContentSearch') {
  async launchContent(request) {
    const plugin = bindings.get(this.endpoint);
    // Application data in the standard search command; reading it never selects or plays audio.
    if (request.autoPlay === false && request.data?.startsWith(catalogueFormat + ':')) {
      const offset = Number(request.data.slice(catalogueFormat.length + 1));
      return { status: ContentLauncher.Status.Success, data: JSON.stringify(cataloguePage(plugin.configRecord, offset)) };
    }
    const parameters = request.search?.parameterList;
    if (!Array.isArray(parameters) || parameters.length !== 1 || parameters[0].type !== ContentLauncher.Parameter.Any) {
      throw new StatusResponse.InvalidCommandError('Indique un seul nom ou identifiant de profil.');
    }
    // Keep the previous Master action usable for existing controllers.
    if (request.data === masterVolumeFormat) {
      const { value } = parameters[0];
      if (request.autoPlay !== false || !/^(?:100|[1-9]?[0-9])$/.test(value)) {
        throw new StatusResponse.InvalidCommandError('Indique un volume Master entre 0 et 100 %.');
      }
      const mixer = await plugin.changeMasterVolume(Number(value), this.context);
      plugin.publishMaster();
      return { status: ContentLauncher.Status.Success, data: JSON.stringify(mixer) };
    }
    if (!this.endpoint.stateOf(OnOffServer).onOff) throw new StatusResponse.FailureError('Le lecteur est éteint.');
    const profile = await plugin.selectProfile(parameters[0].value, request.autoPlay, this.context);
    return { status: ContentLauncher.Status.Success, data: JSON.stringify({ id: profile.id, name: profile.name }) };
  }
}

class LocalKeypadInputServer extends KeypadInputServer {
  sendKey() { return { status: KeypadInput.Status.UnsupportedKey }; }
}
class PlayerPowerServer extends OnOffServer {
  async off() {
    const plugin = bindings.get(this.endpoint);
    await plugin.enqueue(() => plugin.player.stop());
    return super.off();
  }
  async toggle() { return this.state.onOff ? this.off() : this.on(); }
}
class VolumeServer extends LevelControlServer {
  async transition(targetLevel) {
    const level = Math.min(this.maxLevel, Math.max(this.minLevel, targetLevel));
    const mixer = await bindings.get(this.endpoint).changeMasterVolume(Math.round(level * 100 / 254), this.context);
    this.state.currentLevel = levelForMixer(mixer);
    this.agent.get(MuteServer).state.onOff = !mixer.muted;
  }
}
class MuteServer extends OnOffServer {
  async on() { await this.applyMute(false); }
  async off() { await this.applyMute(true); }
  async applyMute(muted) {
    const mixer = await bindings.get(this.endpoint).changeMasterMute(muted, this.context);
    this.state.onOff = !mixer.muted;
    this.agent.get(VolumeServer).state.currentLevel = levelForMixer(mixer);
  }
}

export default function initialize(matterbridge, log, config) { return new AudioPoc(matterbridge, log, config); }

class AudioPoc extends MatterbridgeDynamicPlatform {
  events = [];
  publication = Promise.resolve();
  settingsQueue = Promise.resolve();
  closing = false;

  async onStart() {
    await this.ready;
    if (!this.verifyMatterbridgeVersion('3.11.2', false)) throw new Error('Matterbridge 3.11.2 ou ultérieur est requis pour protéger les API du plugin.');
    this.storagePath = join(this.matterbridge.matterbridgeDirectory, `${this.name}.settings.json`);
    this.configRecord = createRecord();
    try { this.configRecord = readRecord(JSON.parse(await readFile(this.storagePath, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.player = new Player(profileSettings(this.selectedProfile(), this.configRecord.device), () => this.publish());
    this.device = new MatterbridgeEndpoint([basicVideoPlayer, bridgedNode], { id: 'audio-poc-player' })
      .createDefaultBridgedDeviceBasicInformationClusterServer('Lecteur audio', 'audio-poc-player');
    bindings.set(this.device, this);
    this.device.behaviors.require(PlayerPowerServer, { onOff: true });
    this.device.behaviors.require(LocalMediaPlaybackServer, { currentState: MediaPlayback.PlaybackState.NotPlaying });
    this.device.behaviors.require(ProfileContentLauncherServer);
    this.device.behaviors.require(FixedLabelServer, { labelList: this.catalogueLabels() });
    this.device.behaviors.require(LocalKeypadInputServer);
    this.volume = this.device.addChildDeviceType('audio-poc-speaker', speaker);
    bindings.set(this.volume, this);
    this.volume.behaviors.require(MuteServer, { onOff: false });
    this.volume.behaviors.require(VolumeServer, { currentLevel: null, options: {} });
    this.device.addRequiredClusters();
    this.volume.addRequiredClusters();
    await this.registerDevice(this.device);
    this.device.stateOf(LocalMediaPlaybackServer);
    this.volume.stateOf(VolumeServer);
    // Matter restores the previous catalogue from the endpoint's persisted state.
    await this.device.setAttribute(FixedLabel, 'labelList', this.catalogueLabels());
    this.online = true;
    await this.persist();
    this.publish();
    this.publishMaster();
    this.log.info('Lecteur audio prêt · profils nommés, Content Launcher et Media Playback.');
  }

  enqueue(work) {
    const result = this.settingsQueue.then(() => {
      if (this.closing) throw new Error('Le lecteur est arrêté.');
      return work();
    });
    this.settingsQueue = result.catch(() => {});
    return result;
  }

  catalogueLabels() {
    return [
      { label: 'audioProfiles', value: 'v1' },
      { label: 'profileRevision', value: String(this.configRecord.revision) },
      { label: 'audioMaster', value: 'v1' },
    ];
  }

  selectedProfile() {
    return this.configRecord.profiles.find((profile) => profile.id === this.configRecord.selectedId);
  }

  async persist() {
    const record = { ...this.configRecord, runtime: { ...this.player.settings } };
    await writeFile(this.storagePath + '.tmp', JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(this.storagePath + '.tmp', this.storagePath);
    this.configRecord = record;
  }

  selectProfile(reference, play = true, context) {
    return this.enqueue(async () => {
      if (typeof reference !== 'string') throw new StatusResponse.InvalidCommandError('Profil invalide.');
      const profile = this.configRecord.profiles.find((p) => p.id === reference || nameKey(p.name) === nameKey(reference));
      if (!profile) throw new StatusResponse.FailureError('Profil audio introuvable.');
      this.configRecord = { ...this.configRecord, selectedId: profile.id };
      try {
        await this.player.replace(profileSettings(profile, this.configRecord.device), play);
        this.record(play ? 'ContentLauncher.PlayProfile' : 'ContentLauncher.SelectProfile', context, profile.name);
      } finally {
        await this.persist();
        this.publish();
      }
      return profile;
    });
  }

  changeMasterVolume(volume, context) {
    return this.enqueue(async () => {
      const mixer = await setOutputVolume(this.configRecord.device, volume);
      this.record('Master.Volume', context);
      return mixer;
    });
  }

  changeMasterMute(muted, context) {
    return this.enqueue(async () => {
      const mixer = await setOutputMute(this.configRecord.device, muted);
      this.record(muted ? 'Master.Mute' : 'Master.Unmute', context);
      return mixer;
    });
  }

  record(command, context, profile = this.selectedProfile()?.name) {
    const origin = context?.subject?.kind === 'node' && context.subject.id !== 100n ? 'matter' : 'local';
    this.events.unshift({ at: Date.now(), command, origin, profile });
    this.events.length = Math.min(this.events.length, 30);
    this.log.info(`${command} · ${origin} · ${profile} · ${this.player.state}`);
  }

  publish() {
    if (!this.online || this.closing) return;
    this.publication = this.publication.then(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.closing) return;
      await this.device.setAttribute(MediaPlayback, 'currentState', states[this.player.state]);
    }).catch((error) => this.log.error(`Publication audio : ${error.message}`));
  }

  publishMaster() {
    this.publication = this.publication.then(async () => {
      if (!this.online || this.closing) return;
      const mixer = await outputVolume(this.configRecord.device);
      await this.volume.set({
        levelControl: { currentLevel: levelForMixer(mixer) },
        onOff: { onOff: Boolean(mixer && !mixer.muted) },
      });
    }).catch((error) => this.log.error(`Publication audio : ${error.message}`));
  }

  async status() {
    return {
      state: this.player.state, error: this.player.error, settings: this.player.settings, sounds, events: this.events,
      profiles: this.configRecord.profiles, selectedId: this.configRecord.selectedId, device: this.configRecord.device,
      endpoints: { player: this.device.maybeNumber, speaker: this.volume.maybeNumber },
      playbackState: this.device.getAttribute(MediaPlayback, 'currentState'),
      volumeLevel: this.volume.getAttribute(LevelControl, 'currentLevel'), unmuted: this.volume.getAttribute(OnOff, 'onOff'),
      outputMixer: await outputVolume(this.configRecord.device),
    };
  }

  async onFetch(method, path, _query, body) {
    if (method !== 'POST' || !['status', 'settings', 'output-volume', 'output-mute', 'profile', 'remove-profile', 'select-profile', 'play-profile', 'play', 'pause', 'stop'].includes(path)) return undefined;
    if (!this.online || this.closing) return { error: 'Le lecteur démarre ou est arrêté.' };
    try {
      if (path === 'profile' || path === 'remove-profile') {
        await this.enqueue(async () => {
          if (path === 'profile') this.configRecord = saveProfile(this.configRecord, body.profile);
          else {
            const profiles = this.configRecord.profiles.filter((p) => p.id !== body.id);
            if (profiles.length === this.configRecord.profiles.length) throw new Error('Profil introuvable.');
            if (!profiles.length) throw new Error('Conserve au moins un profil.');
            if (body.id === this.configRecord.selectedId && this.player.state !== 'stopped') throw new Error('Arrête la lecture avant de supprimer le profil sélectionné.');
            this.configRecord = { ...this.configRecord, profiles, revision: this.configRecord.revision + 1 };
            if (body.id === this.configRecord.selectedId) {
              this.configRecord.selectedId = profiles[0].id;
              await this.player.replace(profileSettings(profiles[0], this.configRecord.device), false);
            }
          }
          await this.persist();
          await this.device.setAttribute(FixedLabel, 'labelList', this.catalogueLabels());
        });
      } else if (path === 'output-volume') {
        await this.changeMasterVolume(body.volume);
        this.publishMaster();
      } else if (path === 'output-mute') {
        if (typeof body.muted !== 'boolean') return { error: 'Réglages audio invalides.' };
        await this.changeMasterMute(body.muted);
        this.publishMaster();
      } else if (path === 'settings') {
        await this.enqueue(async () => {
          const settings = { ...this.player.settings, device: body.device ?? body.settings?.device };
          if (!validateSettings(settings)) throw new Error('Réglages audio invalides.');
          await this.player.configure(settings);
          this.configRecord.device = settings.device;
          await this.persist();
        });
        this.publishMaster();
      } else if (['select-profile', 'play-profile'].includes(path)) {
        if (!this.device.getAttribute(OnOff, 'onOff')) throw new Error('Le lecteur est éteint.');
        await this.device.invokeBehaviorCommand(ContentLauncher, 'launchContent', {
          search: { parameterList: [{ type: ContentLauncher.Parameter.Any, value: body.id }] }, autoPlay: path === 'play-profile',
        });
      } else if (path !== 'status') {
        if (path === 'play' && !this.device.getAttribute(OnOff, 'onOff')) throw new Error('Le lecteur est éteint.');
        await this.device.invokeBehaviorCommand(MediaPlayback, path);
      }
      await this.settingsQueue;
      await this.publication;
      return await this.status();
    } catch (error) { return { error: error.message }; }
  }

  async onShutdown(reason) {
    this.closing = true;
    this.online = false;
    try {
      await this.settingsQueue;
      await this.player?.close();
      await this.publication;
    } finally { await super.onShutdown(reason); }
  }
}

