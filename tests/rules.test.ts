import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, damageAtRange, fillHeatSinks, formatIssue, resolveSkillValue, skillAvailable, stockBuild, volleyDamage, type Build, type Weapon } from '@mwo/shared';
import { data, ix } from './helpers.ts';

/** Stock mechs that are over the limit in the game itself; all others must be valid. */
const KNOWN_OVERWEIGHT = new Set(['aws-8qs', 'aws-8qss', 'um-aiv', 'um-aivs', 'uzl-2s-j2l']);

test('All stock loadouts satisfy the rules', () => {
  const failures: string[] = [];
  for (const m of data.mechs) {
    if (m.special) continue;
    const a = analyze(stockBuild(m.variant, ix), ix);
    for (const i of a.issues) {
      if (i.code === 'overweight' && KNOWN_OVERWEIGHT.has(m.variant)) continue;
      failures.push(`${m.variant}: ${formatIssue(i, 'en')}`);
    }
  }
  assert.deepEqual(failures.slice(0, 20), []);
});

test('AS7-D stock: 100 t, 48.6 km/h', () => {
  const a = analyze(stockBuild('as7-d', ix), ix);
  assert.equal(a.tonsUsed, 100);
  assert.ok(Math.abs(a.speed - 48.6) < 1e-9);
  assert.equal(a.engine?.rating, 300);
  assert.equal(a.heatSinks.total, 20);
});

test('Quirks apply to the weapon: AC/20 on the AS7-D', () => {
  const ac20 = analyze(stockBuild('as7-d', ix), ix).weapons.find((w) => w.weapon.name === 'AutoCannon20')!;
  // -5 % AC/20, -10 % ballistic
  assert.ok(Math.abs(ac20.cooldown - 3.75 * 0.85) < 1e-9);
});

test('Omnimech: set bonus only with the complete set', () => {
  const full = analyze(stockBuild('adr-prime', ix), ix);
  const isSet = (q: { source: { kind: string; set?: string } }) => q.source.kind === 'set' && q.source.set === 'adr-prime';
  assert.ok(full.quirks.some(isSet));
  const set = ix.chassis.get('adder')!.sets.find((s) => s.name !== 'adr-prime')!;
  const mixed: Build = { ...stockBuild('adr-prime', ix) };
  mixed.pods = { ...mixed.pods, left_leg: set.pods['left_leg']!.id };
  assert.ok(!analyze(mixed, ix).quirks.some(isSet));
});

test('Duplicate pod ID in the game data: SMN-ML keeps its right leg and set bonus', () => {
  const pods = (v: string) => analyze(stockBuild(v, ix), ix).components.filter((c) => c.pod).length;
  assert.equal(pods('smn-ml'), 8);
  assert.equal(ix.pods.get(30775), ix.pods.get(30776));
  const set = ix.chassis.get('summoner')!.sets.find((s) => s.name === 'smn-ml')!;
  if (set.bonuses.length) {
    assert.ok(analyze(stockBuild('smn-ml', ix), ix).quirks.some((q) => q.source.kind === 'set' && q.source.set === 'smn-ml'));
  }
});

test('All pods of all stock loadouts are known', () => {
  for (const l of data.loadouts) {
    for (const c of l.components) if (c.podId !== null) assert.ok(ix.pods.has(c.podId), `${l.variant}: Pod ${c.podId}`);
  }
});

test('At most 16 weapons, AMS included', () => {
  const codes = (b: Build) => analyze(b, ix).issues.map((i) => i.code);
  const smallLaser = data.items.find((i) => i.kind === 'weapon' && i.name === 'SmallLaser')!.id;
  const withWeapons = (n: number) => {
    const b = structuredClone(stockBuild('as7-d', ix));
    b.items = { left_arm: Array(n).fill(smallLaser) };
    return b;
  };
  assert.ok(!codes(withWeapons(16)).includes('weapon-count'));
  assert.ok(codes(withWeapons(17)).includes('weapon-count'));
  assert.equal(analyze(withWeapons(17), ix).weaponCount, 17);

  const ams = data.items.find((i) => i.kind === 'weapon' && i.name === 'AntiMissileSystem')!.id;
  const mixed = withWeapons(16);
  mixed.items['left_torso'] = [ams];
  assert.ok(codes(mixed).includes('weapon-count'));
});

test('Fixed weapons count towards weapon count, alpha and DPS', () => {
  const stock = stockBuild('um-aiv', ix);
  const a = analyze(stock, ix);
  const arrow = a.weapons.find((w) => w.weapon.name === 'ArrowIV');
  assert.ok(arrow, 'Arrow IV missing');
  assert.equal(arrow.count, 1);
  assert.ok(a.alpha >= arrow.damage);
  assert.equal(a.weaponCount, a.weapons.reduce((s, w) => s + w.count, 0));
  assert.ok(!a.notes.some((n) => String(n.params?.['ammo']).includes('ArrowIV')), 'ammo matches the fixed weapon');
});

test('Validation detects errors', () => {
  const codes = (b: Build) => analyze(b, ix).issues.map((i) => i.code);
  const stock = () => structuredClone(stockBuild('as7-d', ix));

  const heavy = stock();
  heavy.items['left_arm'] = [...(heavy.items['left_arm'] ?? []), 1000];
  assert.ok(codes(heavy).includes('overweight'));
  assert.ok(codes(heavy).includes('hardpoints'));

  const armor = stock();
  armor.armor['head'] = 19;
  assert.ok(codes(armor).includes('armor'));

  const engine = stock();
  engine.engineId = data.items.find((i) => i.kind === 'engine' && i.rating === 100)!.id;
  assert.ok(codes(engine).includes('engine-rating'));

  const clan = stock();
  const clanWeapon = data.items.find((i) => i.kind === 'weapon' && i.faction === 'Clan')!;
  clan.items['left_arm'] = [clanWeapon.id];
  assert.ok(codes(clan).includes('item-faction'));
});

test('Volley damage accounts for missiles and LB-X pellets', () => {
  const dmg = (name: string) => {
    const w = data.items.find((i) => i.kind === 'weapon' && i.name === name) as Weapon;
    return volleyDamage(w, w.damage);
  };
  assert.equal(dmg('LBXAutoCannon10'), 10);
  assert.equal(dmg('LRM20'), 20);
  assert.equal(dmg('ClanUltraAutoCannon5'), 5);
  assert.equal(dmg('AutoCannon20'), 20);
});

test('Weapons without reliable DPS are reported, not estimated', () => {
  const b = structuredClone(stockBuild('as7-d', ix));
  const flamer = data.items.find((i) => i.kind === 'weapon' && i.name === 'Flamer')!;
  b.items['left_arm'] = [...(b.items['left_arm'] ?? []), flamer.id];
  const a = analyze(b, ix);
  assert.equal(a.weapons.find((w) => w.weapon.name === 'Flamer')!.dps, 0);
  assert.ok(a.notes.some((n) => n.key === 'note.unknown-dps'));
});

test('Skill values follow the hierarchy faction → class → tonnage → mech', () => {
  const effect = {
    raw: 'x', base: 0, quirk: {} as never,
    overrides: [{
      level: 'Faction' as const, name: 'IS', value: 1,
      children: [{ level: 'WeightClass' as const, name: 'Light', value: 2, children: [{ level: 'Tonnage' as const, name: '35', value: 3, children: [{ level: 'Mech' as const, name: 'Raven', value: 4, children: [] }] }] }],
    }],
  };
  const mech = (over = {}) => ({ faction: 'InnerSphere' as const, weightClass: 'light' as const, tons: 35, chassis: 'raven', ...over });
  assert.equal(resolveSkillValue(effect, mech()), 4);
  assert.equal(resolveSkillValue(effect, mech({ chassis: 'jenner' })), 3);
  assert.equal(resolveSkillValue(effect, mech({ tons: 30 })), 2);
  assert.equal(resolveSkillValue(effect, mech({ weightClass: 'heavy' })), 1);
  assert.equal(resolveSkillValue(effect, mech({ faction: 'Clan' })), 0);
});

test('Skill tree: seven categories like the game, all 239 nodes assigned', () => {
  const byCategory = new Map<string, string[]>();
  for (const s of data.skills) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s.group]);
  assert.deepEqual([...byCategory.keys()], ['Firepower', 'Survival', 'Mobility', 'Jump Jets', 'Operations', 'Sensors', 'Auxiliary']);
  assert.equal(data.skills.reduce((a, s) => a + s.names.length, 0), 239);
  assert.ok(byCategory.get('Firepower')!.includes('Cooldown'));
  assert.ok(byCategory.get('Survival')!.includes('AMSOverload'));
  assert.ok(byCategory.get('Mobility')!.includes('KineticBurst'));
  assert.ok(byCategory.get('Jump Jets')!.includes('LiftSpeed'));
  assert.ok(byCategory.get('Operations')!.includes('CoolRun'));
  assert.ok(byCategory.get('Sensors')!.includes('SensorRange'));
  assert.ok(byCategory.get('Auxiliary')!.includes('ConsumableSlot'));
  assert.equal(data.skills.find((s) => s.group === 'KineticBurst')!.label, 'Kinetic Burst');
});

test('Skill tree: at most 91 nodes', () => {
  const b = stockBuild('as7-d', ix);
  const all = Object.fromEntries(data.skills.map((s) => [s.group, s.names.length]));
  assert.ok(analyze({ ...b, skills: all }, ix).issues.some((i) => i.code === 'skills'));
  const fits = analyze({ ...b, skills: { Cooldown: 16, Range: 15, HeatGen: 14, Velocity: 5, ArmorHardening: 10, SkeletalDensity: 10, KineticBurst: 7, HardBrake: 7, CoolRun: 5, HeatContainment: 2 } }, ix);
  assert.equal(fits.skillNodes, 91);
  assert.ok(!fits.issues.some((i) => i.code === 'skills'));
});

test('Skill tree: requirements are respected', () => {
  const lift = data.skills.find((s) => s.group === 'LiftSpeed')!;
  const ecm = data.skills.find((s) => s.group === 'EnhancedECM')!;
  // AS7-D has neither jump jets nor ECM
  const b = { ...stockBuild('as7-d', ix), skills: { LiftSpeed: 5 } };
  assert.equal(skillAvailable(lift, b, ix), false);
  assert.equal(skillAvailable(ecm, b, ix), false);
  assert.ok(!analyze(b, ix).quirks.some((q) => q.source.kind === 'skill'));
  assert.equal(analyze(b, ix).skillNodes, 0);
  // AS7-K3L has both
  assert.equal(skillAvailable(lift, stockBuild('as7-k3l', ix), ix), true);
  assert.equal(skillAvailable(ecm, stockBuild('as7-k3l', ix), ix), true);
  // Omnimech: ECM depends on the selected pod, KFX-C carries it in the right arm
  assert.equal(skillAvailable(ecm, stockBuild('kfx-c', ix), ix), true);
});

test('Skills only change values when active', () => {
  const base = stockBuild('as7-d', ix);
  const withSkill: Build = { ...base, skills: { Cooldown: 16 } };
  const cd = (b: Build) => analyze(b, ix).weapons.find((w) => w.weapon.name === 'MediumLaser')!.cooldown;
  assert.ok(cd(withSkill) < cd(base));
});

const weaponId = (name: string) => data.items.find((i) => i.kind === 'weapon' && i.name === name)!.id;
const withoutWeapons = (variant: string): Build => {
  const b = structuredClone(stockBuild(variant, ix));
  for (const k of Object.keys(b.items)) b.items[k] = b.items[k]!.filter((id) => !['weapon', 'ammo'].includes(ix.items.get(id)!.kind));
  return b;
};

test('Ghost heat: 3 Snub-Nose PPC on the AS7-D reach 56 % as in the game', () => {
  const b = withoutWeapons('as7-d');
  const snub = weaponId('SnubNosePPC');
  for (const c of ['left_arm', 'right_arm', 'centre_torso']) b.items[c] = [...(b.items[c] ?? []), snub];
  const a = analyze(b, ix);
  assert.deepEqual(a.issues, []);
  // The game shows 56 %, it apparently rounds down
  assert.equal(Math.floor(a.heat.alphaShare * 100), 56);
  assert.ok(a.heat.ghost > 0);
  assert.equal(a.heat.groups.length, 1);
  assert.equal(a.heat.groups[0]!.threshold, 3);
});

test('Ghost heat: two Snub-Nose PPC stay below the threshold', () => {
  const b = withoutWeapons('as7-d');
  const snub = weaponId('SnubNosePPC');
  for (const c of ['left_arm', 'right_arm']) b.items[c] = [...(b.items[c] ?? []), snub];
  assert.equal(analyze(b, ix).heat.ghost, 0);
});

test('Heat peak: stock AS7-D close to the measured 32 %', () => {
  const a = analyze(stockBuild('as7-d', ix), ix);
  assert.equal(a.heat.ghost, 0);
  assert.ok(Math.abs(a.heat.peakShare - 0.32) < 0.015, String(a.heat.peakShare));
  assert.ok(a.heat.alphaShare > a.heat.peakShare);
});

test('Ultra AC double shot is a separate estimate and leaves DPS unchanged', () => {
  const b = withoutWeapons('as7-d');
  b.items['right_torso'] = [...(b.items['right_torso'] ?? []), weaponId('UltraAutoCannon5')];
  const a = analyze(b, ix);
  const uac = a.weapons.find((w) => w.weapon.name === 'UltraAutoCannon5')!;
  assert.ok(Math.abs(uac.dps - uac.damage / uac.cooldown) < 1e-9);
  assert.ok(uac.dpsDoubleShot! > uac.dps && uac.dpsDoubleShot! < 2 * uac.dps);
  assert.ok(a.dpsDoubleShot > a.dps);
  const ml = analyze(stockBuild('as7-d', ix), ix);
  assert.equal(ml.dpsDoubleShot, ml.dps);
});

test('Fill heat sinks uses the remaining weight without creating problems', () => {
  const b = structuredClone(stockBuild('as7-d', ix));
  b.items['left_torso'] = b.items['left_torso']!.filter((id) => ix.items.get(id)!.kind !== 'weapon');
  const before = analyze(b, ix);
  const filled = analyze(fillHeatSinks(b, ix), ix);
  assert.deepEqual(filled.issues, []);
  assert.ok(filled.heatSinks.total > before.heatSinks.total);
  const hs = ix.items.get(ix.upgrades.get(b.heatSinkType)!.compatibleHeatSink!)!;
  assert.ok(filled.tonsMax - filled.tonsUsed < hs.tons || filled.slotsUsed + filled.dynamicSlots + hs.slots > filled.slotsTotal);
});

test('Damage over range follows the breakpoints of the game data', () => {
  const a = analyze(stockBuild('as7-d', ix), ix);
  assert.ok(Math.abs(damageAtRange(a.weapons, 0) - a.weapons.filter((w) => w.weapon.ranges[0]!.modifier > 0).reduce((s, w) => s + w.damage * w.count * w.weapon.ranges[0]!.modifier, 0)) < 1e-9);
  const ml = a.weapons.filter((w) => w.weapon.name === 'MediumLaser');
  // Full damage up to the optimal range, half way to the maximum range half damage, nothing beyond
  assert.equal(damageAtRange(ml, ml[0]!.optimalRange), ml[0]!.damage * ml[0]!.count);
  assert.ok(Math.abs(damageAtRange(ml, (ml[0]!.optimalRange + ml[0]!.maxRange) / 2) - ml[0]!.damage * ml[0]!.count / 2) < 1e-9);
  assert.equal(damageAtRange(ml, ml[0]!.maxRange + 1), 0);
});
