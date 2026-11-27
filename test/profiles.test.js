import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecord, saveProfile, readRecord, cataloguePage } from '../profiles.js';
test('rename preserves the profile identity used by Matter actions', () => {
  const initial = createRecord();
  const next = saveProfile(initial, { ...initial.profiles[0], name: 'Sirène principale' });
  assert.equal(next.profiles[0].id, initial.profiles[0].id);
  assert.equal(next.revision, initial.revision + 1);
  assert.equal(readRecord(next).profiles[0].name, 'Sirène principale');
});
test('invalid volume, duplicate names and broken persisted selections are rejected', () => {
  const record = createRecord();
  assert.throws(() => saveProfile(record, { ...record.profiles[0], volume: 101 }));
  assert.throws(() => saveProfile(record, { ...record.profiles[0], name: record.profiles[1].name }));
  assert.throws(() => readRecord({ ...record, selectedId: 'missing' }));
});
test('profile catalogue is paginated within Matter response bounds without changing selection', () => {
  let record = createRecord(); const original = record.selectedId;
  for (let i = 0; i < 25; i++) record = saveProfile(record, { name: `Profil ${i} abcdefghijklmnopqrstuvwxyz`, sound: 'beep', volume: 25, loop: true, seconds: 0 });
  let offset = 0; const ids = [];
  do { const page = cataloguePage(record, offset); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 800); ids.push(...page.profiles.map((p) => p.id)); offset = page.next; } while (offset !== null);
  assert.deepEqual(ids, record.profiles.map((p) => p.id)); assert.equal(record.selectedId, original);
});
