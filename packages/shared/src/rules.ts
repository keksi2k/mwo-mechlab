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
  /** Confirmed by the player in game: at most 16 weapons, AMS included */
  maxWeapons: 16,
  /** Confirmed by the player: maximum number of skill nodes */
  maxSkillNodes: 91,
  /**
   * Ghost heat: the scale is read from MWOClient.exe (`Meta.ghostHeatScale`).
   * Confirmed in game: 3 Snub-Nose PPC on the AS7-D (56 %), heat quirks also lower the penalty.
   * Unverified: mixed weapons in one group (assumed: lowest threshold of the group, weapons with the smallest penalty first),
   * more weapons than the scale has values (the last value is kept), weapons with a penalty but no group ID (assumed: their own group).
   */
} as const;

/**
 * Unverified estimate for the Ultra AC double shot: each cycle fires one shot plus `ShotsDuringCooldown` extra shots,
 * each of which jams with `JammingChance` (after quirks); a jam costs `JammedTime`.
 * Expected DPS = volley × (1 + s × (1 − p)) / (cooldown + s × p × jammed time).
 */
export function doubleShotDps(w: Weapon, volley: number, cycle: number, applicable: SourcedQuirk[]): number | null {
  const extraShots = Number(w.stats['ShotsDuringCooldown'] ?? 0);
  if (extraShots <= 0 || cycle <= 0) return null;
  const jam = Math.min(1, Math.max(0, applyStat(Number(w.stats['JammingChance'] ?? 0), 'jamchance', applicable)));
  const jammed = Number(w.stats['JammedTime'] ?? 0);
  return volley * (1 + extraShots * (1 - jam)) / (cycle + extraShots * jam * jammed);
}

export interface GameIndex {
  items: Map<number, Item>;
  upgrades: Map<number, Upgrade>;
  mechs: Map<string, Mech>;
  chassis: Map<string, Chassis>;
  pods: Map<number, Pod>;
  loadouts: Map<string, Loadout>;
  skills: SkillNode[];
  /** From the game client; empty if unknown, then no ghost heat is calculated */
  ghostHeatScale: readonly number[];
}

export function buildIndex(
  d: Pick<Dataset, 'items' | 'upgrades' | 'mechs' | 'chassis' | 'loadouts' | 'skills'> & { meta?: Pick<Dataset['meta'], 'ghostHeatScale'> },
): GameIndex {
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
    ghostHeatScale: d.meta?.ghostHeatScale ?? [],
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
  /** Expected DPS with Ultra AC double shot (estimate, see `doubleShotDps`); null for other weapons */
  dpsDoubleShot: number | null;
  /** Ghost heat: group, threshold after quirks and penalty factor; null without ghost heat */
  ghost: { group: string; threshold: number; penalty: number } | null;
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
  /** DPS with Ultra AC double shot (estimate); equals `dps` without Ultra ACs */
  dpsDoubleShot: number;
  hps: number;
  heat: HeatAnalysis;
  weapons: WeaponStats[];
  components: ComponentUsage[];
  quirks: SourcedQuirk[];
  issues: Issue[];
  /** Notes that do not make the build invalid */
  notes: Message[];
  skillNodes: number;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export interface GhostGroup {
  group: string;
  /** Weapons fired together in this group */
  count: number;
  threshold: number;
  /** Extra heat from ghost heat */
  extra: number;
  weapons: { weapon: Weapon; count: number }[];
}

export interface HeatAnalysis {
  /** Heat of one alpha strike without ghost heat */
  alphaBase: number;
  /** Extra heat of one alpha strike from ghost heat */
  ghost: number;
  alphaTotal: number;
  /** Share of the heat capacity after one alpha strike without cooling (1 = 100 %) */
  alphaShare: number;
  /**
   * Estimated peak on the heat bar: beam weapons add their heat over their duration and cooling runs meanwhile.
   * Stock AS7-D: 33.2 %, measured in game 32 %.
   */
  peakShare: number;
  /** Alpha strikes in a row from 0 % before overheating, without cooling in between */
  alphasToOverheat: number;
  /** Seconds to cool down from one alpha strike back to 0 % */
  coolAfterAlpha: number;
  /** Seconds of firing every weapon on cooldown (no ghost heat, chain fire) until overheating; null if cooling keeps up */
  timeToOverheat: number | null;
  groups: GhostGroup[];
}

/** Ghost heat of firing the given weapons together. */
export function ghostHeat(weapons: Pick<WeaponStats, 'weapon' | 'count' | 'heat' | 'ghost'>[], scale: readonly number[]): { total: number; groups: GhostGroup[] } {
  const byGroup = new Map<string, typeof weapons>();
  for (const w of weapons) {
    if (!w.ghost || w.count <= 0) continue;
    byGroup.set(w.ghost.group, [...(byGroup.get(w.ghost.group) ?? []), w]);
  }
  const groups: GhostGroup[] = [];
  for (const [group, ws] of byGroup) {
    const threshold = Math.min(...ws.map((w) => w.ghost!.threshold));
    const shots = ws.flatMap((w) => Array<number>(w.count).fill(w.heat * w.ghost!.penalty)).sort((a, b) => a - b);
    let extra = 0;
    shots.forEach((heatTimesPenalty, i) => {
      const n = i + 1;
      if (n >= threshold && scale.length > 0) extra += heatTimesPenalty * scale[Math.min(n - 1, scale.length - 1)]!;
    });
    groups.push({ group, count: shots.length, threshold, extra, weapons: ws.map((w) => ({ weapon: w.weapon, count: w.count })) });
  }
  return { total: sum(groups.map((g) => g.extra)), groups };
}

export function heatAnalysis(combat: WeaponStats[], capacity: number, cooling: number, hps: number, scale: readonly number[]): HeatAnalysis {
  const alphaBase = sum(combat.map((w) => w.heat * w.count));
  const { total: ghost, groups } = ghostHeat(combat, scale);
  const alphaTotal = alphaBase + ghost;
  // Heat over time is piecewise linear, so the peak lies at t = 0 or at the end of a beam.
  const factor = alphaBase > 0 ? alphaTotal / alphaBase : 1;
  const heatAt = (t: number) => sum(combat.map((w) => w.heat * w.count * factor * (w.duration > 0 ? Math.min(1, t / w.duration) : 1))) - cooling * t;
  const peak = Math.max(heatAt(0), ...combat.filter((w) => w.duration > 0).map((w) => heatAt(w.duration)));
  return {
    alphaBase, ghost, alphaTotal,
    alphaShare: capacity > 0 ? alphaTotal / capacity : 0,
    peakShare: capacity > 0 ? peak / capacity : 0,
    alphasToOverheat: alphaTotal > 0 ? Math.floor(capacity / alphaTotal + 1e-9) : Infinity,
    coolAfterAlpha: cooling > 0 ? Math.min(alphaTotal, capacity) / cooling : Infinity,
    timeToOverheat: hps > cooling ? capacity / (hps - cooling) : null,
    groups,
  };
}

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
  const dpsDoubleShot = dps > 0 && !isContinuous(w) ? doubleShotDps(w, volleyDamage(w, damage), cooldown + duration, applicable) : null;
  const penalty = Number(w.stats['heatpenalty'] ?? 0);
  const level = Number(w.stats['minheatpenaltylevel'] ?? 0);
  const ghost = penalty > 0 && level > 0
    ? { group: w.stats['heatPenaltyID'] ? `g${w.stats['heatPenaltyID']}` : `w${w.id}`, threshold: applyStat(level, 'minheatpenaltylevel', applicable), penalty }
    : null;
  return {
    weapon: w, count, damage: volleyDamage(w, damage), heat, cooldown, duration,
    optimalRange: applyStat(w.optimalRange, 'range', applicable), maxRange: applyStat(w.maxRange, 'range', applicable),
    velocity: applyStat(w.speed, 'velocity', applicable), dps, hps, dpsDoubleShot, ghost, sources: applicable,
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
  const heat = heatAnalysis(combat, heatCapacity, cooling, hps, ix.ghostHeatScale);
  const dpsDoubleShot = sum(combat.map((w) => (w.dpsDoubleShot ?? w.dps) * w.count));

  const skillNodes = sum(ix.skills.filter((n) => skillAvailable(n, build, ix)).map((n) => Math.min(build.skills[n.group] ?? 0, n.names.length)));
  if (skillNodes > ASSUMPTIONS.maxSkillNodes) issues.push({ code: 'skills', params: { count: skillNodes, max: ASSUMPTIONS.maxSkillNodes } });

  return {
    tonsUsed, tonsMax: mech.tons,
    mass: { structure, armor: armorTons, engine: engineTons, items: tonsItems, fixed: tonsFixed },
    armorPoints, armorMaxPoints, slotsUsed, slotsTotal, dynamicSlots, engine, speed,
    heatSinks: { total: inEngine + externalHs, inEngine },
    cooling, heatCapacity, weaponCount, alpha, dps, dpsDoubleShot, hps, heat, weapons, components: usage, quirks, issues, notes, skillNodes,
  };
}

/**
 * Adds heat sinks of the build's type while weight and slots allow: first into the engine's own slots,
 * then into the components with the most free slots. Existing problems of the build stay as they are.
 */
export function fillHeatSinks(build: Build, ix: GameIndex): Build {
  const hsId = ix.upgrades.get(build.heatSinkType)?.compatibleHeatSink;
  if (hsId === undefined) return build;
  const issueKey = (a: Analysis) => a.issues.map((i) => `${i.code}|${i.component ?? ''}`).sort().join(',');
  let current = build;
  let a = analyze(current, ix);
  const allowed = issueKey(a);
  for (let guard = 0; guard < 100; guard++) {
    const order = [...a.components].sort((x, y) => (x.name === 'centre_torso' ? -1 : y.name === 'centre_torso' ? 1 : (y.slotsTotal - y.slotsUsed) - (x.slotsTotal - x.slotsUsed)));
    let added = false;
    for (const u of order) {
      const next = { ...current, items: { ...current.items, [u.name]: [...(current.items[u.name] ?? []), hsId] } };
      const na = analyze(next, ix);
      if (issueKey(na) === allowed) {
        current = next;
        a = na;
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return current;
}

/**
 * Alpha damage at a distance. Between the breakpoints of the game data (`Ranges`) the damage is interpolated linearly,
 * beyond the last one it is 0. Range quirks stretch all breakpoints by the same factor as the maximum range.
 */
export function damageAtRange(weapons: WeaponStats[], range: number): number {
  let total = 0;
  for (const w of weapons) {
    if (w.weapon.hardpoint === 'ams' || w.weapon.ranges.length === 0) continue;
    const factor = w.weapon.maxRange > 0 ? w.maxRange / w.weapon.maxRange : 1;
    const pts = w.weapon.ranges.map((p) => ({ at: p.start * factor, mod: p.modifier }));
    let mod = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const next = pts[i + 1];
      if (range < p.at) break;
      if (!next) {
        mod = range === p.at ? p.mod : 0;
        break;
      }
      if (range <= next.at) {
        mod = next.at > p.at ? p.mod + (next.mod - p.mod) * (range - p.at) / (next.at - p.at) : next.mod;
        break;
      }
    }
    total += w.damage * w.count * mod;
  }
  return total;
}
