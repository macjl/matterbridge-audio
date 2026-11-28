const { t, serverText, profileName, language } = window.PluginUI;
const $ = (id) => document.getElementById(id);
const form = $('settings');
const profileForm = $('profile-form');
const outputForm = $('output-volume');
const outputField = outputForm.elements.namedItem('volume');
let busy = false, opened = false, editing, current;
let editingOutput = false;

async function api(action, fields = {}) {
  const response = await fetch(`./api/${action}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields), cache: 'no-store',
  });
  $('auth-message').hidden = response.status !== 401;
  if (response.status === 401) throw new Error(t("Sign-in to Matterbridge is required."));
  const result = await response.json();
  if (!response.ok || result.error && !result.settings) throw new Error(serverText(result.error) || t("The plugin is unavailable."));
  return result;
}

function button(label, callback, disabled = false) {
  const node = document.createElement('button');
  node.type = 'button'; node.textContent = label; node.disabled = disabled;
  node.addEventListener('click', callback);
  return node;
}

function render(result, settings = false) {
  current = result;
  $('controls').hidden = false;
  const selected = result.profiles.find((p) => p.id === result.selectedId);
  $('state').textContent = `${{ playing: t("Playing"), paused: t("Paused"), stopped: t("Stopped") }[result.state]} · ${profileName(selected?.id, selected?.name) ?? ''}`;
  const mixer = result.outputMixer;
  const output = mixer ? t("Master output {0}%{1}", mixer.volume, mixer.muted ? t(" (muted)") : '') : t("Master volume unavailable");
  $('endpoints').textContent = t("Profile volume {0}% · {1}", result.settings.volume, output);
  $('master-volume-state').textContent = output;
  outputField.disabled = outputForm.querySelector('[type=submit]').disabled = $('mute').disabled = !mixer;
  if (settings || !editingOutput) {
    outputField.value = mixer?.volume ?? '';
    editingOutput = false;
  }
  $('audio-error').textContent = serverText(result.error) || '';
  $('mute').textContent = mixer?.muted ? t("Unmute") : t("Mute");
  if (settings) form.elements.device.value = result.device;
  $('profiles').replaceChildren(...result.profiles.map((profile) => {
    const row = document.createElement('li');
    const sound = serverText(result.sounds.find((s) => s.id === profile.sound)?.name) ?? profile.sound;
    const duration = profile.seconds ? t("Up to {0} s", profile.seconds) : t("Until stopped");
    row.append(document.createTextNode(`${profileName(profile.id, profile.name)} · ${sound} · ${profile.volume} % · ${profile.loop ? duration : t("Once")} `));
    row.append(button(t("Select"), () => request('select-profile', { id: profile.id })),
      button(t("Play"), () => request('play-profile', { id: profile.id })),
      button(t("Edit"), () => editProfile(profile)),
      button(t("Delete"), () => {
        if (confirm(t("Delete profile “{0}”? Actions that use it will no longer be able to play it.", profile.name))) request('remove-profile', { id: profile.id });
      }, result.profiles.length === 1 || (result.selectedId === profile.id && result.state !== 'stopped')));
    return row;
  }));
  $('events').replaceChildren(...result.events.map((event) => {
    const item = document.createElement('li');
    const origin = { matter: t("Matter controller"), local: t("Local interface"), attribute: t("Speaker attribute") }[event.origin];
    item.textContent = `${new Date(event.at).toLocaleTimeString(language)} · ${event.profile ?? ''} · ${event.command} · ${origin}`;
    return item;
  }));
  window.PluginUI?.empty('events', t("No commands since the player started."));
}

function editProfile(profile, reveal = true) {
  $('profile-editor').open = reveal;
  if (reveal) window.PluginUI?.show('profiles');
  editing = profile?.id;
  profileForm.reset();
  $('profile-title').textContent = profile ? t("Edit {0}", profileName(profile.id, profile.name)) : t("New profile");
  if (profile) for (const name of ['name', 'sound', 'loop', 'seconds', 'volume']) {
    const field = profileForm.elements.namedItem(name);
    if (field.type === 'checkbox') field.checked = profile[name]; else field.value = profile[name];
  }
}

async function request(action, fields, settings = false) {
  if (busy) return;
  busy = true;
  window.PluginUI?.busy(true);
  $('controls').inert = true;
  try {
    const result = await api(action, fields);
    if (action === 'profile' || (action === 'remove-profile' && fields.id === editing)) editProfile(undefined, false);
    render(result, settings);
    opened = true;
    $('message').textContent = {
      profile: t("Profile saved."), settings: t("Output saved."), 'output-volume': t("Master volume applied."),
    }[action] ?? '';
  } catch (error) { $('message').textContent = error.message; }
  finally { busy = false; $('controls').inert = false; window.PluginUI?.busy(false); }
}

$('refresh').addEventListener('click', () => request('status', {}, true));
form.addEventListener('submit', (event) => { event.preventDefault(); request('settings', { device: form.elements.device.value.trim() }, true); });
outputField.addEventListener('input', () => { editingOutput = true; });
outputForm.addEventListener('submit', (event) => {
  event.preventDefault();
  request('output-volume', { volume: outputField.valueAsNumber }, true);
});
profileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = profileForm.elements;
  request('profile', { profile: {
    ...(editing ? { id: editing } : {}), name: fields.name.value.trim(), sound: fields.sound.value,
    loop: fields.loop.checked, seconds: Number(fields.seconds.value), volume: Number(fields.volume.value),
  } });
});
$('new-profile').addEventListener('click', () => editProfile());
$('cancel-edit').addEventListener('click', () => editProfile(undefined, false));
$('mute').addEventListener('click', () => request('output-mute', { muted: !current.outputMixer.muted }));
for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', () => request(button.dataset.command));
setInterval(async () => {
  if (!opened || busy) return;
  busy = true;
  try { render(await api('status')); } catch (error) { $('message').textContent = error.message; }
  finally { busy = false; }
}, 1500);
void request('status', {}, true);
