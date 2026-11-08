import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyze, BuildCodeError, buildFromDecoded, decodeBuildCode, decodeNumber, encodeBuildCode, encodeNumber, setArtemis, stockBuild, type Build,
} from '@mwo/shared';
import { data, ix } from './helpers.ts';

// All codes come from the in-game mechlab.
const KFX_C = 'A84D<0J0pB0>J7|0S|0S|0S|0SqB0<J7|URrB0;J7|mB|nB|iB|iBsB0`G7|EC|EC|EC|DC|l<2|m<2tF0?J7uF0@J7vB0:J7w:0:0:0';
const KFX_C_RA_NO_LOWER_ARM = 'A84D<2J0pB0>J7|0S|0S|0S|0SqB0<J7|URrB0;J7|mB|nB|iB|iBsB0`G7|EC|EC|EC|DC|l<2|m<2tF0?J7uF0@J7vB0:J7w:0:0:0';
const AS7D = 'A@000:N1|jb|h^|h^|Y?|Y?p01|X?|@O|@Oq01|Z?|7@|[O|[O|\\O|h^r41|h^|Y?s41|h^|Y?tB1|h^|h^uB1|h^|h^vB0|h^wL0D0D0';
const AS7D_FERRO = 'A@010:N1|jb|h^|h^|Y?|Y?p01|X?|@O|@Oq01|Z?|7@|[O|[O|\\O|h^r41|h^|Y?s41|h^|Y?tB1|h^|h^uB1|h^|h^vB0|h^wL0D0D0';
const AS7D_ENDO = 'A@080:N1|jb|h^|h^|Y?|Y?p01|X?|@O|@Oq01|Z?|7@|[O|[O|\\O|h^r41|h^|Y?s41|h^|Y?tB1|h^|h^uB1|h^|h^vB0|h^wL0D0D0';
const AS7D_DHS = 'A@002:N1|jb|Y?|Y?p01|X?|@O|@Oq01|Z?|7@|[O|[O|\\Or41|Y?s41|Y?tB1uB1vB0wL0D0D0';
const AS7D_ARTEMIS = 'A@001:N1|jb|Y?|Y?p01|X?|@O|@Oq01|^O|^O|_Or41|Y?s41|Y?tB1uB1vB0wL0D0D0';
const ALL = { KFX_C, KFX_C_RA_NO_LOWER_ARM, AS7D, AS7D_FERRO, AS7D_ENDO, AS7D_DHS, AS7D_ARTEMIS };

const mechOf = (code: string) => data.mechs.find((m) => m.id === decodeBuildCode(code).mechId)!;
const load = (code: string) => buildFromDecoded(decodeBuildCode(code), mechOf(code), ix);

test('Numbers: base 64, lowest digit first', () => {
  assert.equal(decodeNumber('EC'), 1237);
  assert.equal(decodeNumber('l<2'), 9020);
  assert.equal(decodeNumber('>J7'), 30350);
  assert.equal(encodeNumber(1237), 'EC');
  assert.equal(encodeNumber(18, 2), 'B0');
  assert.equal(encodeNumber(0, 2), '00');
});

for (const [name, code] of Object.entries(ALL)) {
  test(`${name}: import without warnings, export identical character by character`, () => {
    const { build, warnings } = load(code);
    assert.deepEqual(warnings, []);
    assert.equal(encodeBuildCode(build, mechOf(code), ix).code, code);
  });
}

test('Stock codes match the stock loadouts from the game data', () => {
  for (const [variant, code] of [['kfx-c', KFX_C], ['as7-d', AS7D]] as const) {
    assert.equal(encodeBuildCode(stockBuild(variant, ix), ix.mechs.get(variant)!, ix).code, code, variant);
    assert.deepEqual(analyze(load(code).build, ix).issues, [], variant);
  }
});

test('Header characters: upgrades are recognized', () => {
  const stock = decodeBuildCode(AS7D);
  assert.deepEqual([stock.armorType, stock.structureType, stock.heatSinkType, stock.artemis], [2810, 3100, 3003, false]);
  assert.equal(decodeBuildCode(AS7D_FERRO).armorType, 2811);
  assert.equal(decodeBuildCode(AS7D_ENDO).structureType, 3101);
  assert.equal(decodeBuildCode(AS7D_DHS).heatSinkType, 3002);
  assert.equal(decodeBuildCode(AS7D_ARTEMIS).artemis, true);
  const kfx = decodeBuildCode(KFX_C);
  assert.deepEqual([kfx.armorType, kfx.structureType, kfx.heatSinkType, kfx.artemis], [2815, 3102, 3005, false]);
});

test('Rear armor: order CT, LT, RT (checked in game: CT 5, LT 7, RT 9)', () => {
  const d = decodeBuildCode('A84D<0J0pB0>J7qB0<J7rB0;J7sB0`G7tF0?J7uF0@J7vB0:J7w507090');
  assert.equal(d.armor['centre_torso_rear'], 5);
  assert.equal(d.armor['left_torso_rear'], 7);
  assert.equal(d.armor['right_torso_rear'], 9);
});

test('Actuators: deselection in the right arm is read and affects the slots', () => {
  const d = decodeBuildCode(KFX_C_RA_NO_LOWER_ARM);
  assert.deepEqual(d.actuators, { right: 2, left: 0 });
  const removed = load(KFX_C_RA_NO_LOWER_ARM).build.removedActuators['right_arm']!;
  assert.deepEqual(removed.map((id) => ix.items.get(id)!.name).sort(), ['HandActuator', 'LowerArmActuator']);
  const used = (code: string) => analyze(load(code).build, ix).components.find((c) => c.name === 'right_arm')!.slotsUsed;
  assert.equal(used(KFX_C) - used(KFX_C_RA_NO_LOWER_ARM), 2);
});

test('Arms without deselectable actuators count as "none" (AS7-D)', () => {
  assert.deepEqual(decodeBuildCode(AS7D).actuators, { right: 2, left: 2 });
});

test('Artemis swaps the ammo like the game', () => {
  const stock = stockBuild('as7-d', ix);
  const on = setArtemis(stock, true, ix);
  assert.equal(on.artemis, true);
  assert.deepEqual(on.items['left_torso']!.filter((id) => ix.items.get(id)!.kind === 'ammo'), [2030, 2030, 2031]);
  assert.deepEqual(setArtemis(on, false, ix).items, stock.items);
  assert.deepEqual(analyze(on, ix).notes, [], 'Artemis ammo counts as matching');
});

test('All stock mechs survive export and import without loss', () => {
  const unsupported: string[] = [];
  let checked = 0;
  for (const m of data.mechs) {
    const stock = stockBuild(m.variant, ix);
    const out = encodeBuildCode(stock, m, ix);
    if (out.code === null) {
      unsupported.push(m.variant);
      continue;
    }
    const { build, warnings } = buildFromDecoded(decodeBuildCode(out.code), m, ix);
    assert.deepEqual(warnings, [], m.variant);
    const strip = (b: Build) => ({ ...b, pods: Object.fromEntries(Object.entries(b.pods).sort()), items: Object.fromEntries(Object.entries(b.items).filter(([, v]) => v.length).sort()), removedActuators: Object.fromEntries(Object.entries(b.removedActuators).map(([k, v]) => [k, [...v].sort()]).sort()), armor: Object.fromEntries(Object.entries(b.armor).sort()) });
    assert.deepEqual(strip(build), strip(stock), m.variant);
    checked++;
  }
  assert.deepEqual(unsupported, [], 'all stock builds can be exported');
  assert.ok(checked > 1000, `only ${checked} checked`);
});

test('A foreign pod is reported on import', () => {
  const kfx = ix.mechs.get('kfx-c')!;
  const foreign = data.chassis.find((c) => c.name !== kfx.chassis)!.sets[0]!.pods['left_leg']!.id;
  const code = KFX_C.replace('tF0?J7', `tF0${encodeNumber(foreign)}`);
  const { build, warnings } = buildFromDecoded(decodeBuildCode(code), kfx, ix);
  assert.equal(warnings.length, 1);
  assert.equal(build.pods['left_leg'], stockBuild('kfx-c', ix).pods['left_leg']);
});

test('Mech IDs fit into the two digits of the code', () => {
  assert.ok(data.mechs.every((m) => m.id < 64 * 64));
});

test('Unknown values: import warns and stays on stock', () => {
  const as7 = ix.mechs.get('as7-d')!;
  // Structure index 5 and heat sink code 15 do not exist
  const code = `A${encodeNumber(as7.id, 2)}X^:^0p@0qB0rB0sB0tB0uB0vB0w:0:0:0`;
  const { build, warnings } = buildFromDecoded(decodeBuildCode(code), as7, ix);
  assert.equal(build.structureType, stockBuild('as7-d', ix).structureType);
  assert.equal(build.heatSinkType, stockBuild('as7-d', ix).heatSinkType);
  assert.equal(warnings.length, 2);
});

test('Clan battlemech: both heat sink types like the game', () => {
  const m = ix.mechs.get('as7-d-h')!;
  const double = 'A[lL5:N1|jb|m<2|l<2|l^|l^p01|9C|l^|WR|WRq01|?C|?C|oB|oB|l^|l^|YRr41|mB|mB|l^|l^s41|bB|LR|LRtB1|l^uB1|l^vB0wL0D0D0';
  const single = 'A[lL7:N1|jb|m<2|l<2|h^|h^p01|9C|WR|WRq01|?C|?C|oB|oB|YRr41|mB|mBs41|bB|LR|LRtB1|h^|h^uB1|h^|h^vB0wL0D0D0';
  for (const [code, type] of [[double, 3005], [single, 3006]] as const) {
    const { build, warnings } = buildFromDecoded(decodeBuildCode(code), m, ix);
    assert.deepEqual(warnings, []);
    assert.equal(build.heatSinkType, type);
    assert.deepEqual(analyze(build, ix).issues, []);
    assert.equal((encodeBuildCode(build, m, ix) as { code: string }).code, code);
  }
  assert.equal((encodeBuildCode(stockBuild('as7-d-h', ix), m, ix) as { code: string }).code, double, 'stock like the game');
});

test('Garbage is rejected with a clear error', () => {
  for (const bad of ['', 'hallo', 'A84D', 'A84D<0J0']) assert.throws(() => decodeBuildCode(bad), BuildCodeError, bad);
});
