import { randomUUID } from 'node:crypto';
import { defaults, validateSettings } from './player.js';

export const catalogueFormat = 'audio-profiles.v1';
export const profileFields = ['sound', 'loop', 'seconds', 'volume'];
export const nameKey = (name) => name.normalize('NFKC').trim().toLocaleLowerCase('fr-FR');

export function profileSettings(profile, device, muted = false) {
  return { ...Object.fromEntries(profileFields.map((key) => [key, profile[key]])), device, muted };
}

export function validProfile(profile) {
  return profile && typeof profile.name === 'string' && profile.name.trim().length > 0
    && Buffer.byteLength(profile.name.trim(), 'utf8') <= 48
    && validateSettings(profileSettings(profile, 'default'));
}

export function createRecord(settings = defaults) {
  return {
    version: 1, revision: 1, device: settings.device, selectedId: 'default', runtime: { ...settings },
    profiles: [
      { id: 'default', name: 'Défaut', ...Object.fromEntries(profileFields.map((key) => [key, settings[key]])) },
      { id: 'arming', name: 'Pré-armement', sound: 'beep', loop: true, seconds: 0, volume: 25 },
      { id: 'prealarm', name: 'Préalarme', sound: 'beep', loop: true, seconds: 0, volume: 40 },
      { id: 'alarm', name: 'Alarme', sound: 'alarm', loop: true, seconds: 0, volume: 80 },
    ],
  };
}

export function readRecord(saved) {
  if (validateSettings(saved) && saved.version === undefined) return createRecord(saved);
  if (saved?.version !== 1 || !Array.isArray(saved.profiles) || !saved.profiles.length || saved.profiles.length > 64
    || !Number.isInteger(saved.revision) || saved.revision < 1 || !validateSettings(saved.runtime)
    || !saved.profiles.every((profile) => validProfile(profile) && typeof profile.id === 'string' && /^[a-z0-9-]{1,40}$/.test(profile.id))
    || new Set(saved.profiles.map((p) => p.id)).size !== saved.profiles.length
    || new Set(saved.profiles.map((p) => nameKey(p.name))).size !== saved.profiles.length
    || !saved.profiles.some((p) => p.id === saved.selectedId)
    || !validateSettings({ ...saved.runtime, device: saved.device })) throw new Error('Profils audio enregistrés invalides.');
  return saved;
}

export function saveProfile(record, input) {
  if (!validProfile(input)) throw new Error('Vérifie le nom, le son, le volume et la durée du profil ; raccourcis le nom si nécessaire.');
  if (input.id !== undefined && !record.profiles.some((p) => p.id === input.id)) throw new Error('Profil introuvable.');
  if (input.id === undefined && record.profiles.length >= 64) throw new Error('La limite est de 64 profils.');
  const name = input.name.trim();
  if (record.profiles.some((p) => p.id !== input.id && nameKey(p.name) === nameKey(name))) throw new Error('Ce nom de profil est déjà utilisé.');
  const profile = { id: input.id ?? randomUUID().replaceAll('-', ''), name, ...Object.fromEntries(profileFields.map((key) => [key, input[key]])) };
  return { ...record, revision: record.revision + 1, profiles: input.id ? record.profiles.map((p) => p.id === input.id ? profile : p) : [...record.profiles, profile] };
}

export function cataloguePage(record, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0 || offset > record.profiles.length) throw new Error('Page de profils invalide.');
  const page = { kind: catalogueFormat, profiles: [], next: null };
  let index = offset;
  for (; index < record.profiles.length; index++) {
    const { id, name } = record.profiles[index];
    const candidate = { ...page, profiles: [...page.profiles, { id, name }], next: index + 1 < record.profiles.length ? index + 1 : null };
    if (Buffer.byteLength(JSON.stringify(candidate)) > 800) break;
    page.profiles.push({ id, name });
  }
  page.next = index < record.profiles.length ? index : null;
  return page;
}
