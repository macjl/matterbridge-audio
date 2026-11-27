const $ = (id) => document.getElementById(id);
const form = $('settings');
const profileForm = $('profile-form');
let busy = false, opened = false, editing, current;

async function api(action, fields = {}) {
  const response = await fetch(`./api/${action}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields), cache: 'no-store',
  });
  $('auth-message').hidden = response.status !== 401;
  if (response.status === 401) throw new Error('Connexion à Matterbridge requise.');
  const result = await response.json();
  if (!response.ok || result.error && !result.settings) throw new Error(result.error || 'Le plugin est indisponible.');
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
  $('state').textContent = `${{ playing: 'Lecture en cours', paused: 'En pause', stopped: 'À l’arrêt' }[result.state]} · ${selected?.name ?? ''}`;
  $('endpoints').textContent = `Volume actuel : ${result.settings.volume} %${result.settings.muted ? ' · son coupé' : ''}`;
  $('audio-error').textContent = result.error || '';
  $('mute').textContent = result.settings.muted ? 'Rétablir le son' : 'Couper le son';
  if (settings) form.elements.device.value = result.device;
  $('profiles').replaceChildren(...result.profiles.map((profile) => {
    const row = document.createElement('li');
    const sound = result.sounds.find((s) => s.id === profile.sound)?.name ?? profile.sound;
    const duration = profile.seconds ? `${profile.seconds} s maximum` : 'jusqu’à l’arrêt';
    row.append(document.createTextNode(`${profile.name} · ${sound} · ${profile.volume} % · ${profile.loop ? duration : 'une fois'} `));
    row.append(button('Choisir', () => request('select-profile', { id: profile.id })),
      button('Lire', () => request('play-profile', { id: profile.id })),
      button('Modifier', () => editProfile(profile)),
      button('Supprimer', () => {
        if (confirm(`Supprimer le profil « ${profile.name} » ? Les actions qui l’utilisent ne pourront plus le lancer.`)) request('remove-profile', { id: profile.id });
      }, result.profiles.length === 1 || (result.selectedId === profile.id && result.state !== 'stopped')));
    return row;
  }));
  $('events').replaceChildren(...result.events.map((event) => {
    const item = document.createElement('li');
    const origin = { matter: 'Contrôleur Matter', local: 'Interface locale', attribute: 'Attribut Speaker' }[event.origin];
    item.textContent = `${new Date(event.at).toLocaleTimeString()} · ${event.profile ?? ''} · ${event.command} · ${origin}`;
    return item;
  }));
  window.PluginUI?.empty('events', 'Aucune commande depuis le démarrage du lecteur.');
}

function editProfile(profile, reveal = true) {
  $('profile-editor').open = reveal;
  if (reveal) window.PluginUI?.show('profiles');
  editing = profile?.id;
  profileForm.reset();
  $('profile-title').textContent = profile ? `Modifier ${profile.name}` : 'Nouveau profil';
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
    $('message').textContent = action === 'profile' ? 'Profil enregistré.' : action === 'settings' ? 'Sortie enregistrée.' : '';
  } catch (error) { $('message').textContent = error.message; }
  finally { busy = false; $('controls').inert = false; window.PluginUI?.busy(false); }
}

$('refresh').addEventListener('click', () => request('status', {}, true));
form.addEventListener('submit', (event) => { event.preventDefault(); request('settings', { device: form.elements.device.value.trim() }, true); });
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
$('mute').addEventListener('click', () => request('settings', { settings: { ...current.settings, muted: !current.settings.muted } }));
for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', () => request(button.dataset.command));
setInterval(async () => {
  if (!opened || busy) return;
  busy = true;
  try { render(await api('status')); } catch (error) { $('message').textContent = error.message; }
  finally { busy = false; }
}, 1500);
void request('status', {}, true);
