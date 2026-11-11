import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffDatasets, type Weapon } from '@mwo/shared';
import { data } from './helpers.ts';

test('Patch diff: identical data has no changes', () => {
  const d = diffDatasets(data, data);
  assert.deepEqual([d.mechsAdded, d.mechsRemoved, d.quirks, d.itemsAdded, d.itemsRemoved, d.items], [[], [], [], [], [], []]);
});

test('Patch diff finds changed quirks, pods, weapons and new or removed mechs', () => {
  const next = structuredClone(data);
  next.meta = { ...next.meta, buildVersion: 'next' };
  const as7 = next.mechs.find((m) => m.variant === 'as7-d')!;
  as7.quirks[0]!.value += 0.05;
  const removed = next.mechs.pop()!;
  next.mechs.push({ ...structuredClone(as7), variant: 'new-1', label: 'NEW' });
  const pod = Object.values(next.chassis[0]!.sets[0]!.pods)[0]!;
  pod.quirks.push({ ...as7.quirks[0]!, raw: 'test_quirk_multiplier', label: 'Test', value: 0.1 });
  const ml = next.items.find((i) => i.name === 'MediumLaser') as Weapon;
  const oldHeat = ml.stats['heat']!;
  ml.stats = { ...ml.stats, heat: '4.5' };

  const d = diffDatasets(data, next);
  assert.equal(d.to, 'next');
  assert.deepEqual(d.mechsAdded.map((m) => m.variant), ['new-1']);
  assert.deepEqual(d.mechsRemoved.map((m) => m.variant), [removed.variant]);
  const mechChange = d.quirks.find((q) => q.owner === 'as7-d')!;
  assert.equal(mechChange.changes.length, 1);
  assert.ok(Math.abs(mechChange.changes[0]!.after! - mechChange.changes[0]!.before! - 0.05) < 1e-9);
  const podChange = d.quirks.find((q) => q.kind === 'pod')!;
  assert.deepEqual(podChange.changes.map((c) => [c.raw, c.before, c.after]), [['test_quirk_multiplier', null, 0.1]]);
  assert.deepEqual(d.items.find((i) => i.name === 'MediumLaser')!.changes, [{ key: 'heat', before: oldHeat, after: '4.5' }]);
});
