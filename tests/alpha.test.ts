import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, bestAlpha, computeAlphaRows, decodeBuildCode, rankAlphaRows, type AlphaRow } from '@mwo/shared';
import { ix } from './helpers.ts';

test('Largest clean alpha: BSK-3 reaches 188.5 like the build tested in game', () => {
  const r = bestAlpha(ix.mechs.get('bsk-3')!, ix)!;
  assert.ok(r.proven);
  assert.equal(r.a.alpha, 188.5);
  assert.deepEqual(r.a.issues, []);
  assert.ok(r.a.heat.alphaTotal <= r.a.heatCapacity);
  const names = r.a.weapons.map((w) => `${w.count}x${w.weapon.name}`).sort();
  assert.deepEqual(names, ['1xMediumPulseLaser', '4xMRM40', '6xSmallLaser']);
  // Full armor
  assert.equal(r.a.armorPoints, r.a.armorMaxPoints);
});

test('Clean alpha builds are valid, have full armor and do not overheat', () => {
  for (const v of ['as7-d', 'hbk-4g', 'tbr-prime', 'kfx-prime', 'jr7-iic']) {
    const r = bestAlpha(ix.mechs.get(v)!, ix);
    assert.ok(r, v);
    const a = analyze(r.build, ix);
    assert.deepEqual(a.issues, [], v);
    assert.ok(a.heat.alphaTotal <= a.heatCapacity + 1e-9, v);
    assert.equal(a.armorPoints, a.armorMaxPoints, v);
    assert.ok(a.weaponCount <= 16, v);
  }
});

test('Clean alpha options: weapon types, range and speed are respected', () => {
  const mech = ix.mechs.get('as7-d')!;
  const energy = bestAlpha(mech, ix, { hardpointTypes: ['energy'] })!;
  assert.ok(energy.a.weapons.every((w) => w.weapon.hardpoint === 'energy'));
  const far = bestAlpha(mech, ix, { minRange: 500 })!;
  assert.ok(far.a.weapons.every((w) => w.optimalRange >= 500));
  const fast = bestAlpha(mech, ix, { minSpeed: 55 })!;
  assert.ok(fast.a.speed >= 55);
  assert.ok(fast.a.alpha < bestAlpha(mech, ix)!.a.alpha);
  assert.ok(bestAlpha(mech, ix, { minSpeed: 500 }) === null);
});

test('Ranking: sorted, filtered, omnimechs once per chassis, codes decode to the mech', () => {
  const sample = ['bsk-3', 'as7-d', 'tbr-prime', 'tbr-c', 'hbk-4g'].map((v) => ix.mechs.get(v)!);
  const subset = { ...ix, mechs: new Map(sample.map((m) => [m.variant, m])) };
  const rows: AlphaRow[] = computeAlphaRows(subset, {});
  const ranked = rankAlphaRows(rows, { filters: {} }, ix).rows;
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1]!.alpha >= ranked[i]!.alpha);
  assert.equal(ranked.filter((r) => r.chassis === 'timberwolf').length, 1);
  assert.equal(ranked[0]!.variant, 'bsk-3');
  for (const r of ranked) if (r.code) assert.equal(decodeBuildCode(r.code).mechId, ix.mechs.get(r.variant)!.id);
  assert.ok(rankAlphaRows(rows, { filters: { faction: 'Clan' } }, ix).rows.every((r) => r.faction === 'Clan'));
});
