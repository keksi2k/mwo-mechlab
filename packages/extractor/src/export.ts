import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Dataset, Quirk } from '@mwo/shared';

const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE mechs(variant TEXT PRIMARY KEY, id INTEGER, chassis TEXT, label TEXT, faction TEXT, tons REAL, weight_class TEXT,
  min_engine INTEGER, max_engine INTEGER, max_jump_jets INTEGER, ecm INTEGER, masc INTEGER, omni INTEGER, special INTEGER, ct_set TEXT, speed_factor REAL);
CREATE TABLE components(variant TEXT, name TEXT, slots INTEGER, hp REAL, pod_id INTEGER, PRIMARY KEY(variant, name));
CREATE TABLE hardpoints(owner_kind TEXT, owner TEXT, component TEXT, type TEXT, count INTEGER);
CREATE TABLE omnipod_sets(chassis TEXT, name TEXT, PRIMARY KEY(chassis, name));
CREATE TABLE omnipods(id INTEGER PRIMARY KEY, chassis TEXT, set_name TEXT, component TEXT);
CREATE TABLE quirks(source_kind TEXT, source TEXT, component TEXT, pieces INTEGER, raw TEXT, key TEXT, value REAL, kind TEXT, scope TEXT, target TEXT, stat TEXT, label TEXT);
CREATE TABLE weapons(id INTEGER PRIMARY KEY, name TEXT, label TEXT, faction TEXT, type TEXT, hardpoint TEXT, tons REAL, slots INTEGER, damage REAL, heat REAL, cooldown REAL, duration REAL,
  speed REAL, ammo_type TEXT, min_range REAL, optimal_range REAL, max_range REAL, aliases TEXT, stats TEXT);
CREATE TABLE equipment(id INTEGER PRIMARY KEY, name TEXT, label TEXT, kind TEXT, faction TEXT, tons REAL, slots INTEGER, data TEXT);
CREATE TABLE upgrades(id INTEGER PRIMARY KEY, name TEXT, label TEXT, type TEXT, faction TEXT, data TEXT);
CREATE TABLE loadouts(variant TEXT PRIMARY KEY, name TEXT, armor_type INTEGER, structure_type INTEGER, heat_sink_type INTEGER, artemis INTEGER);
CREATE TABLE loadout_items(variant TEXT, component TEXT, kind TEXT, item_id INTEGER, armor INTEGER);
CREATE TABLE skill_nodes(group_name TEXT, names TEXT);
CREATE TABLE skill_effects(group_name TEXT, raw TEXT, target TEXT, stat TEXT, data TEXT);
CREATE INDEX quirks_target ON quirks(target, stat);
CREATE INDEX quirks_source ON quirks(source);
CREATE INDEX hardpoints_type ON hardpoints(type, owner);
`;

export function writeOutput(data: Dataset, dir: string) {
  mkdirSync(dir, { recursive: true });
  const { meta, items, upgrades, mechs, chassis, loadouts, skills } = data;
  // meta.json last: the server reloads as soon as it changes and then finds all files complete.
  const files: Record<string, unknown> = { items, upgrades, mechs, chassis, loadouts, skills, meta };
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
  writeSqlite(data, join(dir, 'mwo.sqlite'));
}

function writeSqlite(data: Dataset, path: string) {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec('BEGIN');
  const ins = (table: string, n: number) => db.prepare(`INSERT INTO ${table} VALUES (${Array(n).fill('?').join(',')})`);

  const meta = ins('meta', 2);
  for (const [k, v] of Object.entries(data.meta)) meta.run(k, typeof v === 'string' ? v : JSON.stringify(v));

  const quirk = ins('quirks', 12);
  const addQuirks = (kind: string, source: string, component: string | null, pieces: number | null, qs: Quirk[]) => {
    for (const q of qs) quirk.run(kind, source, component, pieces, q.raw, q.key, q.value, q.kind, q.scope, q.target, q.stat, q.label);
  };
  const hp = ins('hardpoints', 5);
  const mech = ins('mechs', 16);
  const comp = ins('components', 5);
  for (const m of data.mechs) {
    mech.run(m.variant, m.id, m.chassis, m.label, m.faction, m.tons, m.weightClass, m.minEngine, m.maxEngine, m.maxJumpJets,
      +m.canEquipECM, +m.canEquipMASC, +m.isOmni, +m.special, m.ctSet, m.movement.maxSpeedFactor);
    for (const c of m.components) {
      comp.run(m.variant, c.name, c.slots, c.hp, c.podId);
      for (const h of c.hardpoints) hp.run('mech', m.variant, c.name, h.type, h.count);
    }
    addQuirks('mech', m.variant, null, null, m.quirks);
  }
  const setRow = ins('omnipod_sets', 2);
  const podRow = ins('omnipods', 4);
  for (const c of data.chassis) {
    for (const s of c.sets) {
      setRow.run(c.name, s.name);
      for (const b of s.bonuses) addQuirks('set', s.name, null, b.pieces, b.quirks);
      for (const p of Object.values(s.pods)) {
        for (const id of [p.id, ...p.aliasIds]) podRow.run(id, c.name, s.name, p.component);
        for (const h of p.hardpoints) hp.run('pod', String(p.id), p.component, h.type, h.count);
        addQuirks('pod', s.name, p.component, null, p.quirks);
      }
    }
  }
  const weapon = ins('weapons', 19);
  const equip = ins('equipment', 8);
  for (const i of data.items) {
    if (i.kind === 'weapon') {
      weapon.run(i.id, i.name, i.label, i.faction, i.weaponType, i.hardpoint, i.tons, i.slots, i.damage, i.heat, i.cooldown, i.duration,
        i.speed, i.ammoType, i.minRange, i.optimalRange, i.maxRange, i.aliases.join(','), JSON.stringify(i.stats));
    } else {
      equip.run(i.id, i.name, i.label, i.kind, i.faction, i.tons, i.slots, JSON.stringify(i));
    }
  }
  const upgrade = ins('upgrades', 6);
  for (const u of data.upgrades) upgrade.run(u.id, u.name, u.label, u.type, u.faction, JSON.stringify(u));
  const lo = ins('loadouts', 6);
  const li = ins('loadout_items', 5);
  for (const l of data.loadouts) {
    lo.run(l.variant, l.name, l.armorType, l.structureType, l.heatSinkType, +l.artemis);
    for (const c of l.components) {
      li.run(l.variant, c.name, 'armor', null, c.armor);
      if (c.podId !== null) li.run(l.variant, c.name, 'pod', c.podId, null);
      for (const id of c.weapons) li.run(l.variant, c.name, 'weapon', id, null);
      for (const id of c.ammo) li.run(l.variant, c.name, 'ammo', id, null);
      for (const id of c.modules) li.run(l.variant, c.name, 'module', id, null);
    }
  }
  const node = ins('skill_nodes', 2);
  const eff = ins('skill_effects', 5);
  for (const s of data.skills) {
    node.run(s.group, s.names.join(','));
    for (const e of s.effects) eff.run(s.group, e.raw, e.quirk.target, e.quirk.stat, JSON.stringify(e.overrides));
  }
  db.exec('COMMIT');
  db.close();
}
