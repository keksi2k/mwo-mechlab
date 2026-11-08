import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeQuirks, baseWeaponStats, evaluateWeaponOnMech, mountableCount, stockBuild, weaponFamilies, weaponOverview, weaponStatLowerIsBetter, weaponStats, WEAPON_STAT_KEYS,
  type Chassis, type Mech, type Pod, type Weapon, type WeaponStatKey,
} from '@mwo/shared';
import { data, ix } from './helpers.ts';

const weapons = data.items.filter((i): i is Weapon => i.kind === 'weapon');
const weapon = (name: string) => weapons.find((w) => w.name === name)!;
const ER_LARGE = ['ERLargeLaser', 'ClanERLargeLaser'];

test('Weapon families group IS and Clan and leave out special weapons', () => {
  const families = weaponFamilies(weapons);
  assert.deepEqual(families.find((f) => f.id === 'erlargelaser')?.weapons, ER_LARGE);
  assert.deepEqual(families.find((f) => f.id === 'largepulselaser')?.weapons, ['LargePulseLaser', 'ClanLargePulseLsr']);
  const names = families.flatMap((f) => f.weapons);
  for (const special of ['NobleAutoCannon20', 'FakeMachineGun', 'DropShipLargePulseLaser']) assert.ok(!names.includes(special), special);
  assert.equal(new Set(names).size, names.length);
});

test('Range adds additive quirks to the base value', () => {
  const mech = data.mechs.find((m) => m.variant === 'rvn-3l')!;
  const stats = weaponStats(weapon('NarcBeacon'), 1, mech.quirks.map((quirk) => ({ quirk, source: { kind: 'mech' as const } })));
  const percent = mech.quirks.filter((q) => q.scope === 'weapon' && q.stat === 'range' && q.kind === 'multiplier' && (q.target === 'all' || weapon('NarcBeacon').aliases.some((a) => a.toLowerCase() === q.target))).reduce((a, q) => a + q.value, 0);
  assert.ok(Math.abs(stats.maxRange - (600 + 100) * (1 + percent)) < 1e-9, `NARC: ${stats.maxRange}`);
});

test('ER Large Laser: ranking matches the mechlab calculation', () => {
  const { rows } = weaponOverview({ weapons: ER_LARGE, sortBy: 'maxRange', filters: {}, limit: 5000 }, ix);
  assert.ok(rows.length > 100);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.stats.maxRange >= rows[i]!.stats.maxRange);
  for (const r of rows) {
    const w = weapons.find((x) => x.id === r.weaponId)!;
    assert.equal(w.faction, r.faction, `${r.variant}: weapon of its own faction`);
    const pods = Object.fromEntries(r.pods.map((p) => [p.component, p.podId]));
    const expected = weaponStats(w, 1, activeQuirks({ variant: r.variant, pods, skills: {} }, ix));
    assert.equal(r.stats.maxRange, expected.maxRange, r.variant);
    assert.ok(r.mountable >= 1, r.variant);
  }
  assert.ok(!rows.some((r) => r.label.endsWith('(T)')), 'test mechs are left out');
  const plain = rows.find((r) => r.sources.length === 0 && r.faction === 'InnerSphere');
  assert.deepEqual(plain?.stats, baseWeaponStats(weapon('ERLargeLaser')));
});

test('Faction filter and minimum count work', () => {
  const clan = weaponOverview({ weapons: ER_LARGE, sortBy: 'maxRange', filters: { faction: 'Clan' }, limit: 5000 }, ix).rows;
  assert.ok(clan.length > 0 && clan.every((r) => r.faction === 'Clan'));
  const many = weaponOverview({ weapons: ER_LARGE, sortBy: 'maxRange', minCount: 6, filters: {}, limit: 5000 }, ix).rows;
  assert.ok(many.length > 0 && many.every((r) => r.mountable >= 6));
});

test('Mechs without a matching hardpoint are missing', () => {
  const { rows } = weaponOverview({ weapons: ['AntiMissileSystem', 'ClanAntiMissileSystem'], sortBy: 'maxRange', filters: {}, limit: 5000 }, ix);
  assert.ok(rows.length > 0 && rows.every((r) => r.hardpoints.ams >= 1));
});

test('No stock loadout exceeds the calculated count', () => {
  let checked = 0;
  for (const mech of data.mechs) {
    if (mech.special || !ix.loadouts.has(mech.variant)) continue;
    const build = stockBuild(mech.variant, ix);
    const placed = new Map<number, number>();
    for (const ids of Object.values(build.items)) {
      for (const id of ids) if (ix.items.get(id)?.kind === 'weapon') placed.set(id, (placed.get(id) ?? 0) + 1);
    }
    for (const [id, n] of placed) {
      const got = mountableCount(mech, build.pods, ix.items.get(id) as Weapon, ix);
      assert.ok(got >= n, `${mech.variant}: ${n}× ${ix.items.get(id)!.name}, calculated ${got}`);
      checked++;
    }
  }
  assert.ok(checked > 1000);
});

/** Exhaustive search as a reference. */
function bruteForce(mech: Mech, ch: Chassis, w: Weapon, key: WeaponStatKey): number | null {
  const comps = mech.components.filter((c) => c.omniSlot && c.podId === null).map((c) => c.name);
  const options = comps.map((c) => ch.sets.map((s) => s.pods[c]).filter((p): p is Pod => !!p));
  const sign = weaponStatLowerIsBetter(key) ? -1 : 1;
  let best: number | null = null;
  const pods: Record<string, number> = {};
  const rec = (i: number) => {
    if (i === comps.length) {
      if (mountableCount(mech, pods, w, ix) < 1) return;
      const s = weaponStats(w, 1, activeQuirks({ variant: mech.variant, pods, skills: {} }, ix));
      const value = (key === 'maxRange' ? s.maxRange : key === 'cooldown' ? s.cooldown : key === 'dps' ? s.dps : s.hps) * sign;
      if (best === null || value > best) best = value;
      return;
    }
    if (options[i]!.length === 0) return rec(i + 1);
    for (const p of options[i]!) {
      pods[comps[i]!] = p.id;
      rec(i + 1);
    }
    delete pods[comps[i]!];
  };
  rec(0);
  return best;
}

test('Pod selection matches exhaustive search', () => {
  const small = [...data.chassis].sort((a, b) => a.sets.length - b.sets.length).slice(0, 4);
  const names = ['ClanERLargeLaser', 'ClanERMediumLaser', 'ClanLRM20', 'ClanUltraAutoCannon5', 'ClanAntiMissileSystem'];
  let checked = 0;
  for (const ch of small) {
    const mech = data.mechs.find((m) => m.chassis === ch.name && m.isOmni)!;
    for (const name of names) {
      const w = weapon(name);
      for (const key of ['maxRange', 'cooldown', 'dps', 'hps'] as const) {
        const expected = bruteForce(mech, ch, w, key);
        const row = evaluateWeaponOnMech(mech, w, key, 1, ix);
        if (expected === null) {
          assert.equal(row, null, `${ch.name} ${name}`);
          continue;
        }
        assert.ok(row, `${ch.name} ${name}`);
        const sign = weaponStatLowerIsBetter(key) ? -1 : 1;
        assert.ok(Math.abs(row.stats[key] * sign - expected) < 1e-9, `${ch.name} ${name} ${key}: ${row.stats[key]} statt ${expected}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 20);
});

test('All columns are filled and the search stays fast', () => {
  const started = performance.now();
  for (const sortBy of WEAPON_STAT_KEYS) weaponOverview({ weapons: ER_LARGE, sortBy, filters: {} }, ix);
  const each = (performance.now() - started) / WEAPON_STAT_KEYS.length;
  console.log(`${Math.round(each)} ms per search`);
  assert.ok(each < 1500, `${each} ms per search`);
  const first = weaponOverview({ weapons: ER_LARGE, sortBy: 'dps', filters: {} }, ix).rows[0]!;
  assert.deepEqual(Object.keys(first.stats).sort(), [...WEAPON_STAT_KEYS].sort());
});
