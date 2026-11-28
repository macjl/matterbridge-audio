# Matterbridge Audio

[![CI](https://github.com/macjl/matterbridge-securitysystem-audio/actions/workflows/ci.yml/badge.svg)](https://github.com/macjl/matterbridge-securitysystem-audio/actions/workflows/ci.yml)

**Preview 0.3.0-alpha.3 · Apache-2.0 · Matterbridge ≥ 3.11.2 · Node.js 24 recommended**

A local audio player controlled through Matter. Use it with an alarm or another compatible controller. FFmpeg generates and plays the audio on the host.

![Audio configuration](docs/images/overview.png)

## How it works

- Create named profiles with a sound, volume, repeat setting, and maximum duration. Built-in sounds include beeps, a soft tone, and a siren.
- Use Media Playback to play, pause, and stop. The Matter Speaker sets the output’s Master volume and mute state.
- Starting another profile replaces playback in progress. Profile IDs stay stable when you rename a profile.
- Playback starts on command. A duration of 0 plays until stopped or replaced when repeat is enabled.

## Configuration

Create profiles in **Sound profiles** and select the ALSA output in **Audio output**. The **Playback** tab has playback controls, and **Log** shows recent commands.

**Audio output** can read and set the audio device’s **Master** mixer when it is available. A positive value unmutes the output. Each profile adjusts the signal that FFmpeg sends to the mixer.

Pair the player with the [Alarm controller](https://github.com/macjl/matterbridge-securitysystem-core). To set the output level before playing, send **Volume (%)** to the **Speaker**, then **Play a profile** to the **Audio player**. Use **Stop playback** when disarming or rearming.

### Matter integration

The player exposes Basic Video Player and Speaker device types. It advertises a profile catalog through the FixedLabel entry `audioProfiles=v1`. Call Content Launcher with `Any="*"`, `AutoPlay=false`, and `Data="audio-profiles.v1:OFFSET"` to retrieve a JSON page containing `kind`, `profiles`, and `next`. Pages are limited to 800 bytes. To play a profile, pass its ID with `AutoPlay=true`.

The Speaker uses Level Control for the ALSA Master and On/Off for its mute switch. Starting a profile applies that profile’s signal volume while retaining the current Master setting. For existing integrations, the player still accepts the legacy `audio-master-volume.v1` Content Launcher command.


## Local installation

```sh
git clone https://github.com/macjl/matterbridge-securitysystem-audio.git
cd matterbridge-securitysystem-audio
# Register the checkout with an existing Matterbridge installation.
matterbridge --add "$PWD"
```

Sign in to Matterbridge and open `/plugins/matterbridge-securitysystem-audio/`. The web interface follows the browser’s preferred supported language, with English as the fallback. Matterbridge 3.11.2 or later provides authentication for the plugin API.

FFmpeg and an ALSA output are required on Linux. The optional Master control uses `amixer` from `alsa-utils`. The Docker image includes both tools. Pass `/dev/snd` into the container.


## Docker

```sh
docker build -t matterbridge-securitysystem-audio:local .
docker compose up -d --no-build
```

The image uses Matterbridge 3.11.5 and stores configuration and pairings in `/data`. Keep that volume when replacing or rebuilding the container. HTTP defaults to port 8284 and Matter to UDP port 5545. Deployment parameters are `POC_HTTP_BIND`, `POC_HTTP_PORT`, `POC_MATTER_PORT`, `POC_MDNS_INTERFACE`, and `POC_DATA_DIR`.

To run all three plugins together, clone the repositories side by side. Run `scripts/build-stack.sh` from the Alarm repository and apply the Audio and Keypad `compose.stack.yaml` overrides. Each plugin also runs independently.


## Development and validation

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

CI checks the source, tests, and package on Node.js 24. Matterbridge supplies the Matter APIs at runtime. UI tests use simulated controllers, and network integration tests use disposable containers and storage.

Run `AUDIO_TEST_IMAGE=matterbridge-securitysystem-audio:local bash test/run.sh` for network tests. To test profiles with Alarm, use `AUDIO_TEST_IMAGE=matterbridge-securitysystem-stack:local bash test/run-profiles.sh`. The profile tests capture PCM into files.
