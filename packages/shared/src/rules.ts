import type { Issue, Message, QuirkSource } from './i18n.ts';
import { factionMatches, quirkAppliesToWeapon } from './quirks.ts';
import {
  COMPONENTS, HARDPOINT_TYPES, REAR_OF,
  type Chassis, type ComponentDef, type Dataset, type Engine, type Hardpoint, type HardpointType, type HeatSink, type InternalRef,
  type Item, type Loadout, type Mech, type Pod, type Quirk, type SkillEffect, type SkillNode, type SkillOverride, type Upgrade, type Weapon,

} from './types.ts';

/**
 * Rules that do NOT come from the game data but are assumptions.
 * Those marked "checked against stock" hold for all stock loadouts (see tests/rules.test.ts);
 * the rest are unverified and need to be compared with the mechlab in the game.
 */
export const ASSUMPTIONS = {
  /** Checked against stock */
  maxHeadArmor: 18,
  /** Checked against stock: maximum armor per component = HP × factor */
  armorPerHp: 2,
  /** Measured in game: the stock AS7-D reaches 32 % on an alpha on cold and hot maps, matching a capacity of 61 */
  baseHeatCapacity: 30,
  /** Measured in game (AS7-D, cooling 3.30: about 7.1 s down to 0 %); map temperature is not taken into account */
  freeEngineHeatSinks: 10,
  /** Observed by the player in game. Whether AMS counts is open: crd-cr and lgb-oh have 16 hardpoints plus 1 AMS. */
  maxWeapons: 16,
  /** Confirmed by the player: maximum number of skill nodes */
  maxSkillNodes: 91,
} as const;

export interface GameIndex {
  items: Map<number, Item>;
  upgrades: Map<number, Upgrade>;
  mechs: Map<string, Mech>;
  chassis: Map<string, Chassis>;
  pods: Map<number, Pod>;
  loadouts: Map<string, Loadout>;
  skills: SkillNode[];
}

export function buildIndex(d: Pick<Dataset, 'items' | 'upgrades' | 'mechs' | 'chassis' | 'loadouts' | 'skills'>): GameIndex {
  const pods = new Map<number, Pod>();
  for (const c of d.chassis) for (const s of c.sets) for (const p of Object.values(s.pods)) for (const id of [p.id, ...p.aliasIds]) pods.set(id, p);
  return {
    items: new Map(d.items.map((i) => [i.id, i])),
    upgrades: new Map(d.upgrades.map((u) => [u.id, u])),
    mechs: new Map(d.mechs.map((m) => [m.variant, m])),
    chassis: new Map(d.chassis.map((c) => [c.name, c])),
    pods,
    loadouts: new Map(d.loadouts.map((l) => [l.variant, l])),
    skills: d.skills,
  };
}

export interface Build {
  variant: string;
  /** Selected pods per component (omnimechs only) */
  pods: Record<string, number>;
  armorType: number;
  structureType: number;
  heatSinkType: number;
  artemis: boolean;
  /** Engine outside fixed parts; null for omnimechs with a fixed engine */
  engineId: number | null;
  /** Armor per component, including rear sides */
  armor: Record<string, number>;
  /** Items installed by the player per component */
  items: Record<string, number[]>;
  /** Deselected actuators (item IDs) per component */
  removedActuators: Record<string, number[]>;
  /** Skill group → number of active nodes */
  skills: Record<string, number>;
}

export function stockBuild(variant: string, ix: GameIndex): Build {
  const mech = ix.mechs.get(variant);
  const lo = ix.loadouts.get(variant);
  if (!mech || !lo) throw new Error(`Unbekannter Mech: ${variant}`);
  const build: Build = {
    variant, pods: {}, armorType: lo.armorType, structureType: lo.structureType, heatSinkType: lo.heatSinkType,
    artemis: lo.artemis, engineId: null, armor: {}, items: {}, removedActuators: {}, skills: {},
  };
  for (const c of lo.components) {
    build.armor[c.name] = c.armor;
    if (c.podId !== null) build.pods[c.name] = c.podId;
    if (c.name.endsWith('_rear')) continue;
    const items: number[] = [];
    for (const id of c.ordered) {
      if (ix.items.get(id)?.kind === 'engine') build.engineId = id;
      else items.push(id);
    }
    build.items[c.name] = items;
  }
  // Stock state of the actuators: None = none, ArmsOnly = no hand, HandsAndArms or missing = both
  for (const [side, state] of [['left_arm', lo.actuators.left], ['right_arm', lo.actuators.right]] as const) {
    if (!state || state.endsWith('HandsAndArms')) continue;
    const def = mech.components.find((c) => c.name === side);
    if (!def) continue;
    const toggleable = resolveComponent(def, build, ix).internals.filter((r) => r.toggleable);
    const removed = toggleable.filter((r) => state.endsWith('None') || ix.items.get(r.id)?.name === 'HandActuator');
    if (removed.length) build.removedActuators[side] = removed.map((r) => r.id);
  }
  return build;
}

/** Toggles Artemis and swaps the ammo of compatible launchers, like the game does. */
export function setArtemis(build: Build, on: boolean, ix: GameIndex): Build {
  const swap = new Map<string, string>();
  for (const i of ix.items.values()) {
    const artemis = i.kind === 'weapon' ? i.stats['artemisAmmoType'] : undefined;
    if (i.kind === 'weapon' && i.ammoType && artemis) {
      if (on) swap.set(i.ammoType, artemis);
      else swap.set(artemis, i.ammoType);
    }
  }
  const replacement = (id: number): number => {
    const item = ix.items.get(id);
    const target = item?.kind === 'ammo' ? swap.get(item.ammoType) : undefined;
    if (!item || !target) return id;
    for (const other of ix.items.values()) {
      if (other.kind === 'ammo' && other.ammoType === target && other.tons === item.tons && other.faction === item.faction) return other.id;
    }
    return id;
  };
  return { ...build, artemis: on, items: Object.fromEntries(Object.entries(build.items).map(([c, ids]) => [c, ids.map(replacement)])) };
}

/** Stealth armor takes fixed slots except in head and centre torso (mask 126 = six components; mapping inferred). */
const STEALTH_COMPONENTS = new Set(['left_torso', 'right_torso', 'left_arm', 'right_arm', 'left_leg', 'right_leg']);

export interface ResolvedComponent {
  name: string;
  slots: number;
  hp: number;
  internals: InternalRef[];
  fixed: number[];
  hardpoints: Hardpoint[];
  canEquipECM: boolean;
  pod: Pod | null;
}

/** Combines the mech definition with the selected pod. A pod replaces the component's hardpoints. */
export function resolveComponent(def: ComponentDef, build: Pick<Build, 'pods'>, ix: GameIndex): ResolvedComponent {
  const podId = def.podId ?? build.pods[def.name];
  const pod = podId !== undefined && podId !== null ? (ix.pods.get(podId) ?? null) : null;
  return {
    name: def.name, slots: def.slots, hp: def.hp,
    internals: pod ? [...def.internals, ...pod.internals] : def.internals,
    fixed: pod ? [...def.fixed, ...pod.fixed] : def.fixed,
    hardpoints: pod ? pod.hardpoints : def.hardpoints,
    canEquipECM: def.canEquipECM || !!pod?.canEquipECM,
    pod,
  };
}

export function resolveSkillValue(e: SkillEffect, mech: Pick<Mech, 'faction' | 'weightClass' | 'tons' | 'chassis'>): number {
  const matches = (o: SkillOverride) => {
    const n = o.name.toLowerCase();
    if (o.level === 'Faction') return n === (mech.faction === 'Clan' ? 'clan' : 'is');
    if (o.level === 'WeightClass') return n === mech.weightClass;
    if (o.level === 'Tonnage') return Number(o.name) === mech.tons;
    return n === mech.chassis;
  };
  let value = e.base;
  let level = e.overrides;
  for (;;) {
    const hit = level.find(matches);
    if (!hit) return value;
    value = hit.value;
    level = hit.children;
  }
}

/** Does the mech meet the skill's requirements (jump jets, ECM, missile hardpoint)? */
export function skillAvailable(node: Pick<SkillNode, 'requires'>, build: Pick<Build, 'variant' | 'pods'>, ix: GameIndex): boolean {
  const mech = ix.mechs.get(build.variant)!;
  const parts = mech.components.map((d) => resolveComponent(d, build, ix));
  return node.requires.every((r) => {
    if (r.equipment === 'JumpJets') return mech.maxJumpJets > 0 || parts.some((p) => p.pod?.quirks.some((q) => q.key === 'jumpjetslots_additive'));
    if (r.hardpoint === 'ECM') return mech.canEquipECM || parts.some((p) => p.canEquipECM);
    if (r.hardpoint) return parts.some((p) => p.hardpoints.some((h) => h.type === r.hardpoint!.toLowerCase()));
    return true;
  });
}

export interface SourcedQuirk { quirk: Quirk; source: QuirkSource }

/** All active quirks with their source. Skills only count when the build activates them. */
export function activeQuirks(build: Pick<Build, 'variant' | 'pods' | 'skills'>, ix: GameIndex): SourcedQuirk[] {
  const mech = ix.mechs.get(build.variant)!;
  const out: SourcedQuirk[] = mech.quirks.map((quirk) => ({ quirk, source: { kind: 'mech' } }));
  const setCounts = new Map<string, number>();
  for (const def of mech.components) {
    const { pod } = resolveComponent(def, build, ix);
    if (!pod) continue;
    setCounts.set(pod.set, (setCounts.get(pod.set) ?? 0) + 1);
    for (const quirk of pod.quirks) out.push({ quirk, source: { kind: 'pod', set: pod.set, component: pod.component } });
  }
  const ch = ix.chassis.get(mech.chassis);
  if (ch) {
    for (const s of ch.sets) {
      for (const b of s.bonuses) {
        if ((setCounts.get(s.name) ?? 0) >= b.pieces) {
          for (const quirk of b.quirks) out.push({ quirk, source: { kind: 'set', set: s.name, pieces: b.pieces } });
        }
      }
    }
  }
  for (const node of ix.skills) {
    const count = Math.min(build.skills[node.group] ?? 0, node.names.length);
    if (count <= 0 || !skillAvailable(node, build, ix)) continue;
    for (const e of node.effects) {
      const value = resolveSkillValue(e, mech) * count;
      if (value !== 0) out.push({ quirk: { ...e.quirk, value }, source: { kind: 'skill', name: node.label, count } });
    }
  }
  return out;
}


export interface WeaponStats {
  weapon: Weapon;
  count: number;
  damage: number;
  heat: number;
  cooldown: number;
  duration: number;
  optimalRange: number;
  maxRange: number;
  velocity: number;
  dps: number;
  hps: number;
  sources: SourcedQuirk[];
}

export interface ComponentUsage {
  name: string;
  slotsTotal: number;
  slotsUsed: number;
  slotsDynamic: number;
  hardpoints: Record<HardpointType, { total: number; used: number }>;
  fixedItems: Item[];
  internals: { item: Item; toggleable: boolean; removed: boolean }[];
  items: Item[];
  armorMax: number;
  hp: number;
  engineSlots: number;
  pod: Pod | null;
}

export interface Analysis {
  tonsUsed: number;
  tonsMax: number;
  mass: { structure: number; armor: number; engine: number; items: number; fixed: number };
  armorPoints: number;
  armorMaxPoints: number;
  slotsUsed: number;
  slotsTotal: number;
  dynamicSlots: number;
  engine: Engine | null;
  speed: number;
  heatSinks: { total: number; inEngine: number };
  cooling: number;
  heatCapacity: number;
  weaponCount: number;
  alpha: number;
  dps: number;
  hps: number;
  weapons: WeaponStats[];
  components: ComponentUsage[];
  quirks: SourcedQuirk[];
  issues: Issue[];
  /** Notes that do not make the build invalid */
  notes: Message[];
  skillNodes: number;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function applyStat(base: number, stat: string, quirks: SourcedQuirk[]): number {
  let add = 0;
  let mul = 0;
  for (const { quirk: q } of quirks) {
    if (q.stat !== stat) continue;
    if (q.kind === 'additive') add += q.value;
    else mul += q.value;
  }
  return (base + add) * (1 + mul);
}

/** Volley damage: damage × projectiles per volley (numFiring, e.g. missiles) × pellets per projectile (numPerShot, e.g. LB-X). */
export const volleyDamage = (w: Weapon, damage: number) =>
  damage * Math.max(1, w.numFiring) * Math.max(1, Number(w.stats['numPerShot'] ?? 1));

/** Weapons whose DPS cannot be derived reliably from the data: one-shot weapons and flamers (no cooldown, no rate of fire). */
export const hasUnknownDps = (w: Weapon) => w.stats['isOneShot'] === '1' || (w.cooldown === 0 && w.rof === null && w.damage > 0);

/** Weapons without a cooldown fire continuously at their rate of fire. */
export const isContinuous = (w: Weapon) => w.rof !== null && w.cooldown === 0;

export function weaponStats(w: Weapon, count: number, all: SourcedQuirk[]): WeaponStats {
  return weaponStatsFrom(w, count, all.filter(({ quirk }) => quirkAppliesToWeapon(quirk, w, true)));
}

/** Like `weaponStats`, but the quirks are already filtered to the weapon. */
export function weaponStatsFrom(w: Weapon, count: number, applicable: SourcedQuirk[]): WeaponStats {
  const damage = applyStat(w.damage, 'damage', applicable);
  const heat = applyStat(w.heat, 'heat', applicable);
  const cooldown = applyStat(w.cooldown, 'cooldown', applicable);
  const duration = Math.max(0, applyStat(w.duration, 'duration', applicable));
  const rof = w.rof === null ? 0 : applyStat(w.rof, 'rof', applicable);
  let dps = 0;
  let hps = 0;
  if (isContinuous(w)) {
    dps = damage * rof;
    hps = heat;
  } else if (!hasUnknownDps(w) && cooldown + duration > 0) {
    dps = volleyDamage(w, damage) / (cooldown + duration);
    hps = heat / (cooldown + duration);
  }
  return {
    weapon: w, count, damage: volleyDamage(w, damage), heat, cooldown, duration,
    optimalRange: applyStat(w.optimalRange, 'range', applicable), maxRange: applyStat(w.maxRange, 'range', applicable),
    velocity: applyStat(w.speed, 'velocity', applicable), dps, hps, sources: applicable,
  };
}

const emptyHardpoints = () => Object.fromEntries(HARDPOINT_TYPES.map((t) => [t, { total: 0, used: 0 }])) as ComponentUsage['hardpoints'];

export function analyze(build: Build, ix: GameIndex): Analysis {
  const mech = ix.mechs.get(build.variant);
  if (!mech) throw new Error(`Unbekannter Mech: ${build.variant}`);
  const issues: Issue[] = [];
  const notes: Message[] = [];
  const armorUp = ix.upgrades.get(build.armorType);
  const structUp = ix.upgrades.get(build.structureType);
  const hsUp = ix.upgrades.get(build.heatSinkType);
  const artemisUp = [...ix.upgrades.values()].find((u) => u.type === 'Artemis' && (u.extraSlots ?? 0) > 0);
  const defs = new Map(mech.components.map((c) => [c.name, c]));

  const quirks = activeQuirks(build, ix);
  const resolved = COMPONENTS.map((n) => defs.get(n)).filter((d): d is ComponentDef => !!d).map((d) => resolveComponent(d, build, ix));

  let engine: Engine | null = null;
  if (build.engineId !== null) {
    const e = ix.items.get(build.engineId);
    if (e?.kind === 'engine') engine = e;
  }
  for (const c of resolved) {
    for (const id of c.fixed) {
      const i = ix.items.get(id);
      if (i?.kind === 'engine') engine = i;
    }
  }
  const engineIsFixed = resolved.some((c) => c.fixed.some((id) => ix.items.get(id)?.kind === 'engine'));
  const heatSinkItem = hsUp?.compatibleHeatSink !== undefined ? (ix.items.get(hsUp.compatibleHeatSink) as HeatSink | undefined) : undefined;

  // Heat sinks in engine slots beyond the free 10 need no slots.
  const engineSlotsForHs = engine ? Math.max(0, engine.heatsinks - ASSUMPTIONS.freeEngineHeatSinks) : 0;
  let hsInEngineSlots = 0;

  let tonsItems = 0;
  let tonsFixed = 0;
  let externalHs = 0;
  const weaponCounts = new Map<number, number>();
  const ammoTypes = new Set<string>();
  const weaponAmmoTypes = new Set<string>();
  const usage: ComponentUsage[] = [];
  const counts = new Map<string, number>();
  let jumpJets = 0;
  let jumpJetItem: Item | null = null;
  let ecmCount = 0;
  let mascCount = 0;

  for (const c of resolved) {
    const internals = c.internals.map((r) => ({
      item: ix.items.get(r.id), toggleable: r.toggleable, removed: r.toggleable && (build.removedActuators[c.name] ?? []).includes(r.id),
    })).filter((x): x is { item: Item; toggleable: boolean; removed: boolean } => !!x.item);
    const fixedItems = c.fixed.map((id) => ix.items.get(id)).filter((i): i is Item => !!i);
    const items = (build.items[c.name] ?? []).map((id) => ix.items.get(id)).filter((i): i is Item => !!i);

    let used = sum(internals.filter((i) => !i.removed).map((i) => i.item.slots));
    const slotsDynamic = armorUp?.fixedSlotsPerComponent && STEALTH_COMPONENTS.has(c.name) ? armorUp.fixedSlotsPerComponent : 0;
    used += slotsDynamic;
    const hp = emptyHardpoints();
    for (const h of c.hardpoints) hp[h.type].total += h.count;

    for (const f of fixedItems) {
      if (f.kind === 'engine') continue;
      tonsFixed += f.tons;
      if (f.kind === 'weapon') {
        weaponCounts.set(f.id, (weaponCounts.get(f.id) ?? 0) + 1);
        if (f.ammoType) weaponAmmoTypes.add(f.ammoType);
      }
      if (f.kind === 'heatsink') {
        externalHs++;
        if (c.name === 'centre_torso' && hsInEngineSlots < engineSlotsForHs) {
          hsInEngineSlots++;
          continue;
        }
      }
      used += f.slots;
    }
    let engineSlots = 0;
    if (engine) {
      if (c.name === 'centre_torso') engineSlots = engine.slots;
      else if (c.name === 'left_torso' || c.name === 'right_torso') engineSlots = engine.sideSlots;
    }
    used += engineSlots;

    for (const item of items) {
      tonsItems += item.tons;
      counts.set(`${item.id}`, (counts.get(`${item.id}`) ?? 0) + 1);
      if (item.kind === 'heatsink') {
        externalHs++;
        if (c.name === 'centre_torso' && hsInEngineSlots < engineSlotsForHs) {
          hsInEngineSlots++;
          continue;
        }
      }
      used += item.slots;
      if (item.kind === 'weapon') {
        hp[item.hardpoint].used++;
        weaponCounts.set(item.id, (weaponCounts.get(item.id) ?? 0) + 1);
        const artemisAmmo = build.artemis ? item.stats['artemisAmmoType'] : undefined;
        if (artemisAmmo) weaponAmmoTypes.add(artemisAmmo);
        else if (item.ammoType) weaponAmmoTypes.add(item.ammoType);
        if (build.artemis && item.artemisCompatible && artemisUp) {
          used += artemisUp.extraSlots ?? 0;
          tonsItems += artemisUp.extraTons ?? 0;
        }
      } else if (item.kind === 'ammo') {
        ammoTypes.add(item.ammoType);
      } else if (item.kind === 'jumpjet') {
        jumpJets++;
        jumpJetItem = item;
      } else if (item.kind === 'ecm') {
        ecmCount++;
        if (!c.canEquipECM && !mech.canEquipECM) issues.push({ code: 'ecm-location', component: c.name, params: { component: c.name } });
      } else if (item.kind === 'masc') {
        mascCount++;
      }
      if (item.components.length > 0 && !item.components.includes(c.name)) {
        issues.push({ code: 'item-location', component: c.name, params: { item: item.label, component: c.name } });
      }
      if (!factionMatches(item.faction, mech.faction)) {
        issues.push({ code: 'item-faction', component: c.name, params: { item: item.label } });
      }
    }
    for (const t of HARDPOINT_TYPES) {
      if (hp[t].used > hp[t].total) {
        issues.push({ code: 'hardpoints', component: c.name, params: { component: c.name, used: hp[t].used, type: t, total: hp[t].total } });
      }
    }
    if (used > c.slots) {
      issues.push({ code: 'slots', component: c.name, params: { component: c.name, used, total: c.slots } });
    }
    usage.push({
      name: c.name, slotsTotal: c.slots, slotsUsed: used, slotsDynamic, hardpoints: hp, fixedItems, internals, items,
      armorMax: c.name === 'head' ? ASSUMPTIONS.maxHeadArmor : c.hp * ASSUMPTIONS.armorPerHp, hp: c.hp, engineSlots, pod: c.pod,
    });
  }

  // Dynamic slots of Ferro/Endo (fixed through internals on omnimechs)
  const dynamicSlots = mech.isOmni ? 0 : (armorUp?.slots ?? 0) + (structUp?.slots ?? 0);
  const slotsTotal = sum(usage.map((u) => u.slotsTotal));
  const slotsUsed = sum(usage.map((u) => u.slotsUsed));
  if (slotsUsed + dynamicSlots > slotsTotal) {
    issues.push({ code: 'slots-total', params: { used: slotsUsed + dynamicSlots, total: slotsTotal, dynamic: dynamicSlots } });
  }

  // Armor
  const armorPoints = sum(Object.values(build.armor));
  let armorMaxPoints = 0;
  for (const u of usage) {
    const rearName = REAR_OF[u.name as keyof typeof REAR_OF];
    const total = (build.armor[u.name] ?? 0) + (rearName ? (build.armor[rearName] ?? 0) : 0);
    armorMaxPoints += u.armorMax;
    if (total > u.armorMax) issues.push({ code: 'armor', component: u.name, params: { component: u.name, armor: total, max: u.armorMax } });
  }

  // Weight
  const structure = (structUp?.weightPerTon ?? 0) * mech.tons;
  const armorTons = armorUp?.armorPerTon ? armorPoints / armorUp.armorPerTon : 0;
  const engineTons = engine?.tons ?? 0;
  const tonsUsed = structure + armorTons + engineTons + tonsItems + tonsFixed;
  if (tonsUsed > mech.tons + 1e-6) issues.push({ code: 'overweight', params: { used: tonsUsed, max: mech.tons } });

  // Engine
  if (!engine) issues.push({ code: 'no-engine' });
  else {
    if (!engineIsFixed && (engine.rating < mech.minEngine || engine.rating > mech.maxEngine)) {
      issues.push({ code: 'engine-rating', params: { rating: engine.rating, min: mech.minEngine, max: mech.maxEngine } });
    }
    if (!factionMatches(engine.faction, mech.faction)) issues.push({ code: 'engine-faction', params: { item: engine.label } });
  }

  // Special equipment
  const jjSlots = sum(quirks.filter((q) => q.quirk.key === 'jumpjetslots_additive').map((q) => q.quirk.value));
  if (jumpJets > mech.maxJumpJets + jjSlots) issues.push({ code: 'jumpjets', params: { count: jumpJets, max: mech.maxJumpJets + jjSlots } });
  const jj = jumpJetItem as Item | null;
  if (jj?.kind === 'jumpjet' && (mech.tons < jj.minTons || mech.tons > jj.maxTons)) {
    issues.push({ code: 'jumpjet-class', params: { item: jj.label, tons: mech.tons } });
  }
  if (ecmCount > 1) issues.push({ code: 'ecm-count' });
  if (mascCount > 0 && !mech.canEquipMASC && !resolved.some((c) => c.pod?.canEquipMASC)) {
    issues.push({ code: 'masc' });
  }
  for (const [id, n] of counts) {
    const item = ix.items.get(Number(id));
    if (item?.amountAllowed !== null && item?.amountAllowed !== undefined && item.kind !== 'case' && n > item.amountAllowed) {
      issues.push({ code: 'amount', params: { item: item.label, count: n, max: item.amountAllowed } });
    }
  }
  for (const a of ammoTypes) if (!weaponAmmoTypes.has(a)) notes.push({ key: 'note.ammo-unused', params: { ammo: a } });
  for (const a of weaponAmmoTypes) if (!ammoTypes.has(a)) notes.push({ key: 'note.weapon-no-ammo', params: { ammo: a } });

  const weaponCount = sum([...weaponCounts.values()]);
  if (weaponCount > ASSUMPTIONS.maxWeapons) issues.push({ code: 'weapon-count', params: { count: weaponCount, max: ASSUMPTIONS.maxWeapons } });

  // Combat values
  const weapons = [...weaponCounts].map(([id, count]) => weaponStats(ix.items.get(id) as Weapon, count, quirks));
  const combat = weapons.filter((w) => w.weapon.hardpoint !== 'ams');
  for (const w of combat) if (hasUnknownDps(w.weapon)) notes.push({ key: 'note.unknown-dps', params: { item: w.weapon.label } });
  const alpha = sum(combat.map((w) => w.damage * w.count));
  const dps = sum(combat.map((w) => w.dps * w.count));
  const hps = sum(combat.map((w) => w.hps * w.count));

  const inEngine = engine ? Math.min(engine.heatsinks, ASSUMPTIONS.freeEngineHeatSinks) : 0;
  const hs = heatSinkItem;
  const cooling = applyStat((hs?.engineCooling ?? 0) * inEngine + (hs?.cooling ?? 0) * externalHs, 'heatdissipation', quirks);
  const heatCapacity = applyStat(
    ASSUMPTIONS.baseHeatCapacity - (hs?.engineHeatbase ?? 0) * inEngine - (hs?.heatbase ?? 0) * externalHs, 'maxheat', quirks,
  );
  const speed = engine
    ? applyStat(engine.rating / mech.tons * mech.movement.maxSpeedFactor, 'mechtopspeed', quirks)
    : 0;

  const skillNodes = sum(ix.skills.filter((n) => skillAvailable(n, build, ix)).map((n) => Math.min(build.skills[n.group] ?? 0, n.names.length)));
  if (skillNodes > ASSUMPTIONS.maxSkillNodes) issues.push({ code: 'skills', params: { count: skillNodes, max: ASSUMPTIONS.maxSkillNodes } });

  return {
    tonsUsed, tonsMax: mech.tons,
    mass: { structure, armor: armorTons, engine: engineTons, items: tonsItems, fixed: tonsFixed },
    armorPoints, armorMaxPoints, slotsUsed, slotsTotal, dynamicSlots, engine, speed,
    heatSinks: { total: inEngine + externalHs, inEngine },
    cooling, heatCapacity, weaponCount, alpha, dps, hps, weapons, components: usage, quirks, issues, notes, skillNodes,
  };
}
