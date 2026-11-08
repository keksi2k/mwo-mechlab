import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateMech, SEARCH_PRESETS, searchMechs, type Chassis, type Criterion, type Mech, type Pod, type SearchQuery } from '@mwo/shared';
import { data, ix } from './helpers.ts';

const AMS = ['AntiMissileSystem', 'ClanAntiMissileSystem'];
const preset = (id: string): SearchQuery => {
  const p = SEARCH_PRESETS.find((x) => x.id === id)!;
  return { filters: p.filters, criteria: p.criteria, limit: 5000 };
};

test('AMS search: sorted by hardpoints, shows quirks with their source', () => {
  const { rows } = searchMechs(preset('ams'), ix);
  assert.ok(rows.length > 100);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.hardpoints.ams >= rows[i]!.hardpoints.ams);

  const find = (v: string) => rows.find((r) => r.variant === v || r.alsoVariants.includes(v));
  const wolfhound = find('wlf-1b');
  assert.ok(wolfhound, 'wlf-1b missing');
  assert.equal(wolfhound.values[1]!.value, 1.5, 'wlf-1b: AMS damage');
  assert.deepEqual(wolfhound.values[1]!.sources[0]!.source, { kind: 'mech' });
  assert.equal(find('tdr-9st'), undefined, 'test mech is left out');
  for (const chassis of ['iceferret', 'kitfox', 'mistlynx']) {
    const row = rows.find((r) => r.chassis === chassis);
    assert.ok(row, `${chassis} missing`);
    assert.ok(row.values[2]!.value > 0 || row.values[3]!.value > 0, `${chassis}: Clan AMS quirk`);
    // Kit Fox has the quirk in the set bonus, the others in a pod
    assert.ok(row.values.flatMap((v) => v.sources).some((s) => s.source.kind === 'pod' || s.source.kind === 'set'), `${chassis}: Herkunft`);
  }
});

test('Test mechs never appear in the search', () => {
  const tests = data.mechs.filter((m) => m.label.endsWith('(T)'));
  assert.equal(tests.length, 16);
  assert.ok(tests.every((m) => m.special));
  const { rows } = searchMechs({ filters: {}, criteria: [], limit: 5000 }, ix);
  assert.ok(!rows.some((r) => r.label.endsWith('(T)') || r.alsoVariants.some((v) => tests.some((m) => m.variant === v))));
});

test('Only one row per omni chassis', () => {
  const { rows } = searchMechs(preset('ams'), ix);
  const omni = rows.filter((r) => r.isOmni).map((r) => r.chassis);
  assert.equal(new Set(omni).size, omni.length);
});

test('Global quirks do not count for AMS', () => {
  const row = evaluateMech(ix.mechs.get('as7-d')!, {
    filters: {}, criteria: [{ kind: 'weaponQuirk', weapons: AMS, stat: 'cooldown', includeGlobal: true }],
  }, ix)!;
  assert.equal(row.row.values[0]!.value, 0);
});

test('Filters work', () => {
  const run = (filters: SearchQuery['filters']) => searchMechs({ filters, criteria: [], limit: 5000 }, ix).rows;
  assert.ok(run({ faction: 'Clan' }).every((r) => r.faction === 'Clan'));
  assert.ok(run({ weightClasses: ['light'] }).every((r) => r.tons <= 35));
  assert.ok(run({ minTons: 90 }).every((r) => r.tons >= 90));
  assert.ok(run({ omni: 'only' }).every((r) => r.isOmni));
  assert.ok(run({ requireJumpJets: true }).every((r) => r.maxJumpJets > 0));
  assert.ok(run({ minHardpoints: { missile: 6 } }).every((r) => r.hardpoints.missile >= 6));
  assert.ok(run({ requireECM: true }).every((r) => r.canEquipECM));
  assert.ok(!run({}).some((r) => r.variant === 'as7-d-dc-escort'));
});

test('Criteria with asc sort ascending', () => {
  const { rows } = searchMechs({ filters: {}, criteria: [{ kind: 'mech', field: 'tons', dir: 'asc' }], limit: 5000 }, ix);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.tons <= rows[i]!.tons);
});

/** Exhaustive search as a reference for the optimization. */
function bruteForce(mech: Mech, ch: Chassis, criteria: Criterion[], minAms: number): number[] | null {
  const comps = mech.components.filter((c) => c.omniSlot && c.podId === null).map((c) => c.name);
  const options = comps.map((c) => ch.sets.map((s) => s.pods[c]).filter((p): p is Pod => !!p));
  const ctPod = ch.sets.flatMap((s) => Object.values(s.pods)).find((p) => p.id === mech.components.find((c) => c.podId !== null)?.podId);
  let best: number[] | null = null;
  const pick: Pod[] = [];
  const signOf = (c: Criterion) => (c.kind === 'weaponQuirk' && c.stat === 'cooldown' ? -1 : 1);
  const score = () => {
    const pods = ctPod ? [...pick, ctPod] : pick;
    const counts = new Map<string, number>();
    for (const p of pods) counts.set(p.set, (counts.get(p.set) ?? 0) + 1);
    const quirks = [...mech.quirks, ...pods.flatMap((p) => p.quirks)];
    for (const s of ch.sets) for (const b of s.bonuses) if ((counts.get(s.name) ?? 0) >= b.pieces) quirks.push(...b.quirks);
    const fixedHp = mech.components.filter((c) => !c.omniSlot).flatMap((c) => c.hardpoints);
    const hps = [...fixedHp, ...pods.flatMap((p) => p.hardpoints)];
    const ams = hps.filter((h) => h.type === 'ams').reduce((a, h) => a + h.count, 0);
    if (ams < minAms) return;
    const vec = criteria.map((c) => {
      if (c.kind === 'hardpoints') return hps.filter((h) => h.type === c.type).reduce((a, h) => a + h.count, 0) * signOf(c);
      if (c.kind === 'quirk') return quirks.filter((q) => q.key === c.key).reduce((a, q) => a + q.value, 0) * signOf(c);
      return 0;
    });
    if (!best || compare(vec, best) > 0) best = vec;
  };
  const rec = (i: number) => {
    if (i === options.length) return score();
    if (options[i]!.length === 0) return rec(i + 1);
    for (const p of options[i]!) {
      pick[i] = p;
      rec(i + 1);
    }
    pick.length = i;
  };
  rec(0);
  return best;
}
function compare(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    if (Math.abs(d) > 1e-9) return d;
  }
  return 0;
}

test('Pod optimization matches exhaustive search', () => {
  const smallest = [...data.chassis].sort((a, b) => a.sets.length - b.sets.length).slice(0, 4);
  // Also includes the chassis with the 6-piece set bonus
  const six = data.chassis.find((c) => c.sets.some((s) => s.bonuses.some((b) => b.pieces === 6)));
  const chassis = six && six.sets.length <= 6 ? [...smallest, six] : smallest;
  const queries: { criteria: Criterion[]; minAms: number }[] = [
    { criteria: [{ kind: 'hardpoints', type: 'energy' }, { kind: 'hardpoints', type: 'missile' }], minAms: 0 },
    { criteria: [{ kind: 'quirk', key: 'heatdissipation_multiplier' }, { kind: 'hardpoints', type: 'ballistic' }], minAms: 0 },
    { criteria: [{ kind: 'quirk', key: 'xpbonus_multiplier' }, { kind: 'hardpoints', type: 'energy' }], minAms: 0 },
    { criteria: [{ kind: 'hardpoints', type: 'energy' }], minAms: 1 },
  ];
  let checked = 0;
  for (const ch of chassis) {
    const mech = data.mechs.find((m) => m.chassis === ch.name && m.isOmni)!;
    for (const q of queries) {
      const expected = bruteForce(mech, ch, q.criteria, q.minAms);
      const got = evaluateMech(mech, { filters: { minHardpoints: { ams: q.minAms } }, criteria: q.criteria }, ix);
      if (expected === null) {
        assert.equal(got, null, `${ch.name}: cannot be satisfied`);
        continue;
      }
      assert.ok(got, `${ch.name}: no solution found`);
      assert.equal(compare(got.vec, expected), 0, `${ch.name} ${JSON.stringify(q.criteria)}: ${got.vec} instead of ${expected}`);
      checked++;
    }
  }
  assert.ok(checked >= 10);
});

test('The 6-piece set bonus is used by the optimization', () => {
  const ch = data.chassis.find((c) => c.sets.some((s) => s.bonuses.some((b) => b.pieces === 6)))!;
  const set = ch.sets.find((s) => s.bonuses.some((b) => b.pieces === 6))!;
  const bonus = set.bonuses.find((b) => b.pieces === 6)!;
  const quirk = bonus.quirks[0]!;
  const mech = data.mechs.find((m) => m.chassis === ch.name)!;
  const got = evaluateMech(mech, { filters: {}, criteria: [{ kind: 'quirk', key: quirk.key, dir: quirk.value > 0 ? 'desc' : 'asc' }] }, ix)!;
  const sources = got.row.values[0]!.sources;
  assert.ok(sources.some((s) => s.source.kind === 'set'), `No set bonus for ${quirk.key}: ${JSON.stringify(sources)}`);
});
