import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuirkName, type Weapon } from '@mwo/shared';
import { data, ix } from './helpers.ts';

const allQuirks = () => [
  ...data.mechs.flatMap((m) => m.quirks),
  ...data.chassis.flatMap((c) => c.sets.flatMap((s) => [...s.bonuses.flatMap((b) => b.quirks), ...Object.values(s.pods).flatMap((p) => p.quirks)])),
];

test('Counts match the preliminary analysis', () => {
  assert.equal(data.mechs.length, 1308);
  assert.equal(data.loadouts.length, 1308);
  assert.equal(data.items.filter((i) => i.kind === 'weapon').length, 147);
  assert.equal(data.chassis.length, 34);
  assert.equal(data.skills.length, 55);
  assert.equal(new Set(allQuirks().map((q) => q.raw)).size, 360);
});

test('AC/20 has the values from Weapons.xml', () => {
  const w = ix.items.get(1000) as Weapon;
  assert.equal(w.label, 'AC/20');
  assert.equal(w.damage, 20);
  assert.equal(w.heat, 5);
  assert.equal(w.cooldown, 3.75);
  assert.equal(w.tons, 14);
  assert.equal(w.slots, 10);
  assert.equal(w.optimalRange, 300);
  assert.equal(w.maxRange, 600);
});

test('AS7-D: base data and quirk', () => {
  const m = ix.mechs.get('as7-d')!;
  assert.equal(m.label, 'ATLAS AS7-D');
  assert.equal(m.tons, 100);
  assert.equal(m.minEngine, 200);
  assert.equal(m.maxEngine, 360);
  assert.equal(m.isOmni, false);
  assert.equal(m.quirks.find((q) => q.key === 'isautocannon20_cooldown_multiplier')?.value, -0.05);
});

test('AS7-D: hardpoint count comes from the WeaponSlots', () => {
  const m = ix.mechs.get('as7-d')!;
  const count = (t: string) => m.components.flatMap((c) => c.hardpoints).filter((h) => h.type === t).reduce((a, h) => a + h.count, 0);
  assert.equal(count('energy'), 4);
  assert.equal(count('missile'), 2);
  // Two WeaponSlots with their own attachment points (as7_right_torso_*_bh1 and _bh2)
  assert.equal(count('ballistic'), 2);
  assert.equal(count('ams'), 1);
});

test('ADR-PRIME: pod quirks and set bonus are separate', () => {
  const m = ix.mechs.get('adr-prime')!;
  assert.equal(m.isOmni, true);
  assert.equal(m.ctSet, 'adr-prime');
  const set = ix.chassis.get('adder')!.sets.find((s) => s.name === 'adr-prime')!;
  assert.deepEqual(set.bonuses.map((b) => b.pieces), [8]);
  assert.ok(set.bonuses[0]!.quirks.some((q) => q.key === 'clanerppc_cooldown_multiplier'));
  assert.ok(set.pods['left_arm']!.quirks.some((q) => q.key === 'clanerppc_velocity_multiplier'));
  assert.ok(!set.pods['left_arm']!.quirks.some((q) => q.key === 'clanerppc_cooldown_multiplier'));
});

test('Every quirk is parsed and every weapon target matches a weapon', () => {
  const aliases = new Set(data.items.flatMap((i) => (i.kind === 'weapon' ? [i.name.toLowerCase(), ...i.aliases.map((a) => a.toLowerCase())] : [])));
  const bad = new Set<string>();
  for (const q of allQuirks()) {
    assert.ok(parseQuirkName(q.raw), `Cannot parse: ${q.raw}`);
    if (q.scope === 'weapon' && q.target !== 'all' && !aliases.has(q.target!)) bad.add(q.raw);
  }
  assert.deepEqual([...bad], []);
});

test('Quirk forms are parsed correctly', () => {
  assert.deepEqual(parseQuirkName('isgaussrifle_cooldown_multiplier'), {
    key: 'isgaussrifle_cooldown_multiplier', kind: 'multiplier', scope: 'weapon', target: 'isgaussrifle', stat: 'cooldown',
  });
  assert.equal(parseQuirkName('ammocapacity_clrm_artemis_additive')?.target, 'clrm_artemis');
  assert.equal(parseQuirkName('armorresist_ct_additive')?.scope, 'armor');
  assert.equal(parseQuirkName('heatdissipation_multiplier')?.target, null);
  assert.equal(parseQuirkName('jumpjets_heat_multiplier')?.scope, 'mech');
  assert.equal(parseQuirkName('rotaryautoCannon2_minheatpenaltylevel_additive')?.target, 'rotaryautocannon2');
});

test('Display names contain no raw names', () => {
  const raw = new Set(allQuirks().filter((q) => /_(multiplier|additive)$/.test(q.label)).map((q) => q.raw));
  assert.deepEqual([...raw], []);
});

test('No unexpected extraction warnings', () => {
  assert.deepEqual(data.meta.warnings.filter((w) => !w.startsWith('Special variant')), []);
});

test('Game files stay unchanged: paks are opened read-only', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../packages/extractor/src/pak.ts', import.meta.url), 'utf8');
  assert.ok(!/writeFile|createWriteStream|unlink|rmSync/.test(src));
});

test('Mech names always include the chassis, also for hero variants', () => {
  const expected: Record<string, string> = {
    'sr-k': 'STONE RHINO KOLOSS', 'bsk-3': 'BULLSHARK BSK-3', 'dwf-uv': 'DIRE WOLF ULTRAVIOLET', 'fnr-wr': 'FAFNIR WRATH',
    'bsk-vk': 'BULLSHARK CLAN VOID KILLER', 'as7-d': 'ATLAS AS7-D', 'as7-d-h': 'ATLAS CLAN AS7-D-H', 'dwf-w': 'DIRE WOLF DWF-W',
  };
  for (const [variant, label] of Object.entries(expected)) assert.equal(data.mechs.find((m) => m.variant === variant)?.label, label);
  // The Behemoth's hero has the same name as its chassis
  const short = data.mechs.filter((m) => !m.label.includes(' ') && m.label !== 'BEHEMOTH').map((m) => m.label);
  assert.deepEqual(short, []);
});
