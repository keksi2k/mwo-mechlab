import { encodeBuildCode } from './buildcode.ts';
import { factionMatches } from './quirks.ts';
import {
  analyze, ASSUMPTIONS, ghostHeat, isContinuous, resolveComponent, stockBuild, weaponStats,
  type Analysis, type Build, type GameIndex,
} from './rules.ts';
import { matchesStatic, type SearchFilters } from './search.ts';
import {
  HARDPOINT_TYPES, REAR_OF,
  type Ammo, type Engine, type Faction, type HardpointType, type HeatSink, type Mech, type Pod, type Upgrade, type Weapon, type WeightClass,
} from './types.ts';

/**
 * Largest alpha strike per mech: weapons, heat sinks and ammo are chosen so that one alpha strike
 * (including ghost heat) stays within the heat capacity, with full armor.
 *
 * Simplifications, see README:
 * - full armor (front/rear 3:1 on the torsos), no skills, no jump jets, ECM, Artemis or other equipment
 * - one ton of ammo per ammo type, single heat sinks (they give more heat capacity per ton and slot than doubles)
 * - battlemechs: the lightest engine per type that reaches the minimum speed, plus rating 250 if lower
 * - omnimechs: pods improved one component at a time, starting with the variant's own pods
 * - no cooling during the alpha strike (conservative), no heat from the map
 */
export interface AlphaOptions {
  /** Allow different weapons of one ghost heat group together. The rule for that is unverified. */
  mixGhostGroups?: boolean;
  /** Only these weapon types; empty or missing = all */
  hardpointTypes?: HardpointType[];
  /** Only weapons with at least this optimal range (after quirks) */
  minRange?: number;
  /** Battlemechs: the engine must reach this speed (km/h) */
  minSpeed?: number;
}

export interface AlphaQuery {
  options: AlphaOptions;
  filters: Pick<SearchFilters, 'text' | 'faction' | 'weightClasses' | 'minTons' | 'maxTons' | 'omni'>;
  limit?: number;
}

export interface AlphaRow {
  variant: string;
  label: string;
  chassis: string;
  faction: Faction;
  tons: number;
  weightClass: WeightClass;
  isOmni: boolean;
  alpha: number;
  heat: number;
  ghost: number;
  capacity: number;
  speed: number;
  /** false: best found, not proven best (search limit or omnimech pod heuristic) */
  proven: boolean;
  weapons: { name: string; label: string; hardpoint: HardpointType; count: number }[];
  build: Build;
  /** Build code for the game, null if the build cannot be encoded */
  code: string | null;
  alsoVariants: string[];
}

export interface AlphaResult { total: number; rows: AlphaRow[] }

interface Candidate {
  weapon: Weapon;
  damage: number;
  heat: number;
  tons: number;
  slots: number;
  /** Ghost group; weapons without ghost heat get their own key */
  group: string;
  /** Heat of n copies fired together, including ghost heat */
  heatOf: number[];
  threshold: number;
  penalty: number;
  ammoType: string | null;
  ammo: Ammo | null;
}

interface Slot { name: string; free: number; hp: Record<HardpointType, number>; }

interface Config {
  build: Build;
  base: Analysis;
  /** Tons left for weapons, ammo and heat sinks */
  tons: number;
  /** Free slots per component after internals, fixed items and engine */
  slots: Slot[];
  /** Slots needed anywhere: Endo/Ferro */
  dynamic: number;
  /** Heat sinks that fit into the engine's own slots in the centre torso */
  engineHsSlots: number;
  heatSink: HeatSink;
  /** Heat capacity without extra heat sinks, and the gain per extra heat sink */
  capacity: number;
  capacityPerSink: number;
  /** Extra heat sinks needed to reach 10 in total */
  minSinks: number;
  fixedWeapons: number;
  fixedDamage: number;
  fixedHeat: number;
  candidates: Candidate[];
}

const SPECIAL_WEAPON = /^(Fake|DropShip)/;
/** Search steps for placing the weapons into components before giving up */
const PLACEMENT_BUDGET = 400;
/** Search nodes per configuration in the quick first pass */
const QUICK_NODES = 3000;
/** Search nodes per configuration in the full pass; beyond that the result is the best found, not proven best */
const FULL_NODES = 150_000;
/** Omnimechs: pod searches from this many of the best starting points */
const OMNI_STARTS = 3;

function ghostHeatSeries(heat: number, threshold: number, penalty: number, max: number): number[] {
  const scale = ASSUMPTIONS.ghostHeatScale;
  const out = [0];
  for (let n = 1; n <= max; n++) {
    const extra = penalty > 0 && n >= threshold ? heat * penalty * scale[Math.min(n - 1, scale.length - 1)]! : 0;
    out.push(out[n - 1]! + heat + extra);
  }
  return out;
}

function maxArmor(build: Build, a: Analysis): Record<string, number> {
  const armor: Record<string, number> = {};
  for (const u of a.components) {
    const rear = REAR_OF[u.name as keyof typeof REAR_OF];
    if (rear) {
      armor[rear] = Math.round(u.armorMax * 0.25);
      armor[u.name] = u.armorMax - armor[rear]!;
    } else armor[u.name] = u.armorMax;
  }
  return { ...build.armor, ...armor };
}

/** The empty mech with full armor and all deselectable actuators removed. */
function skeleton(mech: Mech, pods: Record<string, number>, ix: GameIndex, upgrades: { armor: number; structure: number; heatSink: number } | null, engineId: number | null): Build {
  const stock = stockBuild(mech.variant, ix);
  const build: Build = {
    ...stock, pods: { ...stock.pods, ...pods }, items: {}, skills: {}, artemis: false,
    armorType: upgrades?.armor ?? stock.armorType, structureType: upgrades?.structure ?? stock.structureType,
    heatSinkType: upgrades?.heatSink ?? stock.heatSinkType, engineId: engineId ?? stock.engineId,
  };
  const removed: Record<string, number[]> = {};
  for (const def of mech.components) {
    const toggles = resolveComponent(def, build, ix).internals.filter((r) => r.toggleable).map((r) => r.id);
    if (toggles.length) removed[def.name] = toggles;
  }
  build.removedActuators = removed;
  build.armor = maxArmor(build, analyze(build, ix));
  return build;
}

function prepare(mech: Mech, build: Build, ix: GameIndex, opts: AlphaOptions, ammoByType: Map<string, Ammo[]>): Config | null {
  const base = analyze(build, ix);
  if (base.issues.some((i) => i.code !== 'overweight' && i.code !== 'slots-total')) return null;
  const hsType = ix.upgrades.get(build.heatSinkType);
  const heatSink = ix.items.get(hsType?.compatibleHeatSink ?? -1);
  if (heatSink?.kind !== 'heatsink') return null;
  const engine = base.engine;
  const quirks = base.quirks;
  const capMul = quirks.filter((q) => q.quirk.stat === 'maxheat' && q.quirk.kind === 'multiplier').reduce((s, q) => s + q.quirk.value, 0);

  const slots: Slot[] = base.components.map((u) => ({
    name: u.name, free: u.slotsTotal - u.slotsUsed, hp: Object.fromEntries(HARDPOINT_TYPES.map((t) => [t, u.hardpoints[t].total])) as Record<HardpointType, number>,
  }));
  const allowed = new Set(opts.hardpointTypes?.length ? opts.hardpointTypes : HARDPOINT_TYPES);
  const present = new Set(HARDPOINT_TYPES.filter((t) => t !== 'ams' && allowed.has(t) && slots.some((s) => s.hp[t] > 0)));

  const fixedWeapons = base.weapons.filter((w) => w.weapon.hardpoint !== 'ams' && w.count > 0);
  const candidates: Candidate[] = [];
  for (const item of ix.items.values()) {
    if (item.kind !== 'weapon' || item.hardpoint === 'ams' || !present.has(item.hardpoint) || SPECIAL_WEAPON.test(item.name)) continue;
    // Continuous-fire weapons (machine guns, flamers) have no meaningful single volley
    if (isContinuous(item) || (item.cooldown === 0 && item.rof === null)) continue;
    if (!factionMatches(item.faction, mech.faction)) continue;
    const st = weaponStats(item, 1, quirks);
    if (st.damage <= 0 || st.optimalRange < (opts.minRange ?? 0)) continue;
    const ammo = item.ammoType ? (ammoByType.get(item.ammoType) ?? []).filter((a) => factionMatches(a.faction, mech.faction)).sort((x, y) => x.tons - y.tons)[0] ?? null : null;
    if (item.ammoType && !ammo) continue;
    const series = ghostHeatSeries(st.heat, st.ghost?.threshold ?? Infinity, st.ghost?.penalty ?? 0, ASSUMPTIONS.maxWeapons);
    candidates.push({
      weapon: item, damage: st.damage, heat: st.heat, tons: item.tons, slots: item.slots,
      group: st.ghost?.group ?? `w${item.id}`, heatOf: series, threshold: st.ghost?.threshold ?? Infinity, penalty: st.ghost?.penalty ?? 0,
      ammoType: item.ammoType, ammo,
    });
  }
  // Drop weapons that are worse in every respect than another weapon of the same type and group
  const dominated = (a: Candidate, b: Candidate) => a !== b && a.weapon.hardpoint === b.weapon.hardpoint && a.group === b.group
    && b.damage >= a.damage && b.tons <= a.tons && b.slots <= a.slots && b.heatOf.every((h, n) => h <= a.heatOf[n]! + 1e-9)
    && (!b.ammoType || b.ammoType === a.ammoType) && b.weapon.components.length === 0
    && (b.damage > a.damage || b.tons < a.tons || b.slots < a.slots || b.heat < a.heat);
  const kept = candidates.filter((a) => !candidates.some((b) => dominated(a, b)));
  // Most efficient first, so good solutions are found early and the suffix bounds shrink quickly
  const perSink = -heatSink.heatbase * (1 + capMul) / heatSink.tons;
  const eff = (c: Candidate) => c.damage / (c.tons + c.heat / perSink);
  kept.sort((a, b) => eff(b) - eff(a) || b.damage - a.damage);

  const inEngine = base.heatSinks.inEngine;
  const fixedSinks = base.heatSinks.total - inEngine;
  return {
    build, base, tons: base.tonsMax - base.tonsUsed, slots, dynamic: base.dynamicSlots,
    // Fixed heat sinks in the centre torso already use up the engine's own slots
    engineHsSlots: engine ? Math.max(0, engine.heatsinks - ASSUMPTIONS.freeEngineHeatSinks
      - (base.components.find((u) => u.name === 'centre_torso')?.fixedItems.filter((i) => i.kind === 'heatsink').length ?? 0)) : 0,
    heatSink, capacity: base.heatCapacity, capacityPerSink: -heatSink.heatbase * (1 + capMul),
    minSinks: Math.max(0, ASSUMPTIONS.freeEngineHeatSinks - inEngine - fixedSinks),
    fixedWeapons: fixedWeapons.reduce((s, w) => s + w.count, 0) + base.weapons.filter((w) => w.weapon.hardpoint === 'ams').reduce((s, w) => s + w.count, 0),
    fixedDamage: fixedWeapons.reduce((s, w) => s + w.damage * w.count, 0),
    fixedHeat: base.heat.alphaTotal,
    candidates: kept,
  };
}

/** Places the weapons into components with matching hardpoints and enough slots. Returns the component per weapon or null. */
function place(cfg: Config, weapons: Candidate[], stats: SearchStats): number[] | null {
  const order = weapons.map((w, i) => i).sort((a, b) => weapons[b]!.slots - weapons[a]!.slots || weapons[a]!.weapon.id - weapons[b]!.weapon.id);
  const comps = cfg.slots.length;
  const free = cfg.slots.map((s) => s.free);
  const hp = cfg.slots.map((s) => ({ ...s.hp }));
  // Quick necessary checks
  for (const t of HARDPOINT_TYPES) {
    const need = weapons.filter((w) => w.weapon.hardpoint === t);
    if (need.length === 0) continue;
    const room = cfg.slots.filter((s) => s.hp[t] > 0);
    if (need.length > room.reduce((a, s) => a + s.hp[t], 0)) return null;
  }
  const out = new Array<number>(weapons.length);
  // Weapons are sorted by size, so a valid placement is found quickly when one exists; the budget stops hopeless cases.
  let budget = PLACEMENT_BUDGET;
  const go = (k: number, minComp: number): boolean => {
    if (k === order.length) return true;
    if (--budget < 0) return false;
    const i = order[k]!;
    const w = weapons[i]!;
    const t = w.weapon.hardpoint;
    const sameAsNext = k + 1 < order.length && weapons[order[k + 1]!]!.weapon.id === w.weapon.id;
    for (let c = minComp; c < comps; c++) {
      if (hp[c]![t] <= 0 || free[c]! < w.slots) continue;
      if (w.weapon.components.length > 0 && !w.weapon.components.includes(cfg.slots[c]!.name)) continue;
      hp[c]![t]--;
      free[c]! -= w.slots;
      out[i] = c;
      // Identical weapons are placed in non-decreasing component order, which avoids trying permutations
      if (go(k + 1, sameAsNext ? c : 0)) return true;
      hp[c]![t]++;
      free[c]! += w.slots;
    }
    return false;
  };
  const ok = go(0, 0);
  // Gave up without proof that no placement exists
  if (!ok && budget < 0) stats.complete = false;
  return ok ? out : null;
}

/** Alpha heat with exact ghost heat when weapons of one group are mixed. */
function mixedHeat(cfg: Config, cands: Candidate[], counts: number[]): number {
  const chosen = cands.map((c, i) => ({ c, count: counts[i]! })).filter((x) => x.count > 0);
  const { total } = ghostHeat(chosen.map(({ c, count }) => ({
    weapon: c.weapon, count, heat: c.heat,
    ghost: c.penalty > 0 ? { group: c.group, threshold: c.threshold, penalty: c.penalty } : null,
  })));
  return cfg.fixedHeat + chosen.reduce((s, { c, count }) => s + c.heat * count, 0) + total;
}

interface Solution { counts: number[]; alpha: number; heat: number; sinks: number; placement: number[]; weapons: Candidate[] }

/** Branch and bound over the number of copies per weapon. */
function solve(cfg: Config, opts: AlphaOptions, mustBeat: number, maxNodes: number, stats: SearchStats): Solution | null {
  let nodes = 0;
  const cands = cfg.candidates;
  const n = cands.length;
  const counts = new Array<number>(n).fill(0);
  const totalHp = Object.fromEntries(HARDPOINT_TYPES.map((t) => [t, cfg.slots.reduce((s, c) => s + c.hp[t], 0)])) as Record<HardpointType, number>;
  const usedHp = Object.fromEntries(HARDPOINT_TYPES.map((t) => [t, 0])) as Record<HardpointType, number>;
  const groupUsed = new Map<string, number>();
  const ammoUsed = new Map<string, number>();
  const sinkTons = cfg.heatSink.tons;
  const totalFree = cfg.slots.reduce((s, c) => s + c.free, 0) - cfg.dynamic;
  const maxWeapons = ASSUMPTIONS.maxWeapons - cfg.fixedWeapons;
  // Heat sinks turn tons and slots into heat capacity; the bound prices a weapon's heat in those.
  const perSinkTon = cfg.capacityPerSink / sinkTons;
  const perSinkSlot = cfg.capacityPerSink / Math.max(1, cfg.heatSink.slots);
  // Suffix maxima for the bound
  const perTon = new Array<number>(n + 1).fill(0);
  const perSlot = new Array<number>(n + 1).fill(0);
  const effTon = new Array<number>(n + 1).fill(0);
  const effSlot = new Array<number>(n + 1).fill(0);
  const perWeapon = new Array<number>(n + 1).fill(0);
  const perType = Array.from({ length: n + 1 }, () => Object.fromEntries(HARDPOINT_TYPES.map((t) => [t, 0])) as Record<HardpointType, number>);
  for (let i = n - 1; i >= 0; i--) {
    const c = cands[i]!;
    const ratio = (cost: number) => (cost > 0 ? c.damage / cost : Infinity);
    perTon[i] = Math.max(perTon[i + 1]!, ratio(c.tons));
    perSlot[i] = Math.max(perSlot[i + 1]!, ratio(c.slots));
    effTon[i] = Math.max(effTon[i + 1]!, ratio(c.tons + c.heat / perSinkTon));
    effSlot[i] = Math.max(effSlot[i + 1]!, ratio(c.slots + c.heat / perSinkSlot));
    perWeapon[i] = Math.max(perWeapon[i + 1]!, c.damage);
    perType[i] = { ...perType[i + 1]! };
    perType[i]![c.weapon.hardpoint] = Math.max(perType[i]![c.weapon.hardpoint], c.damage);
  }
  let best: Solution | null = null;
  let bestAlpha = mustBeat;
  const placeCache = new Map<string, number[] | null>();
  const placed = (): { weapons: Candidate[]; placement: number[] } | null => {
    const weapons: Candidate[] = [];
    counts.forEach((k, i) => { for (let j = 0; j < k; j++) weapons.push(cands[i]!); });
    const key = counts.join(',');
    let p = placeCache.get(key);
    if (p === undefined) {
      p = place(cfg, weapons, stats);
      placeCache.set(key, p);
    }
    return p ? { weapons, placement: p } : null;
  };

  const visit = (i: number, damage: number, heat: number, tons: number, slots: number, weapons: number, checkPlacement: boolean): void => {
    if (++nodes > maxNodes) {
      stats.complete = false;
      return;
    }
    const ammoTons = [...ammoUsed.values()].reduce((s, x) => s + x, 0);
    const ammoSlots = ammoUsed.size;
    const tonsLeft = cfg.tons - tons - ammoTons - cfg.minSinks * sinkTons;
    if (tonsLeft < -1e-9) return;
    const slotsLeft = totalFree - slots - ammoSlots;
    if (slotsLeft + cfg.engineHsSlots - cfg.minSinks < 0) return;
    const capLeft = cfg.capacity + cfg.minSinks * cfg.capacityPerSink - heat;
    const extraSinks = Math.max(0, Math.min(Math.floor(tonsLeft / sinkTons + 1e-9), slotsLeft + cfg.engineHsSlots - cfg.minSinks));
    // Heat only grows from here: if even all possible heat sinks are not enough, no completion is valid.
    if (capLeft + extraSinks * cfg.capacityPerSink < -1e-9) return;

    if (i < n) {
      // Upper bound for the remaining weapons (LP relaxation of tons, slots, heat and hardpoints)
      const weaponsLeft = maxWeapons - weapons;
      const byType = HARDPOINT_TYPES.reduce((s, t) => s + perType[i]![t] * Math.max(0, totalHp[t] - usedHp[t]), 0);
      let bound = Math.min(perTon[i]! * tonsLeft, perSlot[i]! * slotsLeft, perWeapon[i]! * weaponsLeft, byType);
      const slotBudget = slotsLeft + cfg.engineHsSlots - cfg.minSinks;
      bound = Math.min(bound, effTon[i]! * (tonsLeft + capLeft / perSinkTon), effSlot[i]! * (slotBudget + capLeft / perSinkSlot));
      if (damage + Math.max(0, bound) <= bestAlpha + 1e-9) return;
    } else if (damage <= bestAlpha + 1e-9) return;

    const p = checkPlacement || i === n ? placed() : null;
    if ((checkPlacement || i === n) && !p) return;

    if (i === n) {
      const sinks = cfg.minSinks + extraSinks;
      const exactHeat = opts.mixGhostGroups ? mixedHeat(cfg, cands, counts) : heat;
      if (exactHeat > cfg.capacity + sinks * cfg.capacityPerSink + 1e-9) return;
      best = { counts: [...counts], alpha: damage, heat: exactHeat, sinks, placement: p!.placement, weapons: p!.weapons };
      bestAlpha = damage;
      return;
    }

    const c = cands[i]!;
    const t = c.weapon.hardpoint;
    let max = Math.min(totalHp[t] - usedHp[t], maxWeapons - weapons, c.tons > 0 ? Math.floor((tonsLeft + 1e-9) / c.tons) : Infinity);
    if (!opts.mixGhostGroups && c.group.startsWith('g') && (groupUsed.get(c.group) ?? 0) > 0) max = 0;
    for (let k = max; k >= 1; k--) {
      counts[i] = k;
      usedHp[t] += k;
      groupUsed.set(c.group, (groupUsed.get(c.group) ?? 0) + k);
      const newAmmo = c.ammoType !== null && !ammoUsed.has(c.ammoType);
      if (newAmmo) ammoUsed.set(c.ammoType!, c.ammo!.tons);
      // With mixed groups this underestimates the ghost heat; the leaf computes it exactly.
      visit(i + 1, damage + c.damage * k, heat + c.heatOf[k]!, tons + c.tons * k, slots + c.slots * k, weapons + k, true);
      if (newAmmo) ammoUsed.delete(c.ammoType!);
      groupUsed.set(c.group, groupUsed.get(c.group)! - k);
      usedHp[t] -= k;
    }
    counts[i] = 0;
    visit(i + 1, damage, heat, tons, slots, weapons, false);
  };
  visit(0, cfg.fixedDamage, cfg.fixedHeat, 0, 0, 0, false);
  return best;
}

/** Turns a solution into a build: weapons where placed, ammo and heat sinks into free slots, heat sinks first into the engine. */
function toBuild(cfg: Config, sol: Solution): Build {
  const items: Record<string, number[]> = {};
  const free = cfg.slots.map((s) => s.free);
  sol.weapons.forEach((w, i) => {
    const c = sol.placement[i]!;
    const name = cfg.slots[c]!.name;
    (items[name] ??= []).push(w.weapon.id);
    free[c]! -= w.slots;
  });
  // Endo/Ferro take their slots from what is left; keep them free, largest components first
  let dynamic = cfg.dynamic;
  const reserve = free.map(() => 0);
  const byFree = free.map((f, i) => i).sort((a, b) => free[b]! - free[a]!);
  for (const c of byFree) {
    const take = Math.min(dynamic, free[c]!);
    reserve[c] = take;
    free[c]! -= take;
    dynamic -= take;
  }
  const putAnywhere = (id: number, slots: number) => {
    const c = free.findIndex((f) => f >= slots);
    if (c < 0) return false;
    (items[cfg.slots[c]!.name] ??= []).push(id);
    free[c]! -= slots;
    return true;
  };
  const ammo = new Map<string, Ammo>();
  for (const w of sol.weapons) if (w.ammoType && w.ammo) ammo.set(w.ammoType, w.ammo);
  for (const a of ammo.values()) putAnywhere(a.id, a.slots);
  let sinks = sol.sinks;
  for (let k = 0; k < Math.min(sinks, cfg.engineHsSlots); k++) (items['centre_torso'] ??= []).push(cfg.heatSink.id);
  sinks -= Math.min(sinks, cfg.engineHsSlots);
  while (sinks > 0 && putAnywhere(cfg.heatSink.id, cfg.heatSink.slots)) sinks--;
  return { ...cfg.build, items };
}

interface SearchStats { complete: boolean }

function evaluate(
  mech: Mech, build: Build, ix: GameIndex, opts: AlphaOptions, ammoByType: Map<string, Ammo[]>, mustBeat: number, maxNodes: number, stats: SearchStats,
): { build: Build; a: Analysis } | null {
  const cfg = prepare(mech, build, ix, opts, ammoByType);
  if (!cfg) return null;
  const sol = solve(cfg, opts, mustBeat, maxNodes, stats);
  if (!sol) return null;
  const result = toBuild(cfg, sol);
  const a = analyze(result, ix);
  // The search and analyze() use the same rules; a mismatch would be a bug, so such a build is dropped rather than shown
  if (a.issues.length > 0 || a.heat.alphaTotal > a.heatCapacity + 1e-6) return null;
  // Omnimechs keep their engine, so the speed limit is checked here
  if (a.speed < (opts.minSpeed ?? 0) - 1e-9) return null;
  return { build: result, a };
}

function ammoIndex(ix: GameIndex): Map<string, Ammo[]> {
  const map = new Map<string, Ammo[]>();
  for (const i of ix.items.values()) if (i.kind === 'ammo') map.set(i.ammoType, [...(map.get(i.ammoType) ?? []), i]);
  return map;
}

/** Engine candidates for a battlemech: per type the lightest one that reaches the minimum speed, plus rating 250 if that is lower. */
function engineCandidates(mech: Mech, ix: GameIndex, minSpeed: number, speedMul: number): Engine[] {
  const engines = [...ix.items.values()].filter((i): i is Engine =>
    i.kind === 'engine' && factionMatches(i.faction, mech.faction) && i.rating >= mech.minEngine && i.rating <= mech.maxEngine
    && i.rating / mech.tons * mech.movement.maxSpeedFactor * (1 + speedMul) >= minSpeed - 1e-9);
  const out: Engine[] = [];
  for (const type of new Set(engines.map((e) => e.engineType))) {
    const list = engines.filter((e) => e.engineType === type).sort((a, b) => a.rating - b.rating);
    const first = list[0];
    if (!first) continue;
    out.push(first);
    const r250 = list.find((e) => e.rating >= 250);
    if (r250 && r250 !== first) out.push(r250);
  }
  return out;
}

/** Best alpha for one mech, or null if no valid build was found. */
export interface AlphaBuild { build: Build; a: Analysis; /** false if the search hit a limit or used the pod heuristic */ proven: boolean }

export function bestAlpha(mech: Mech, ix: GameIndex, opts: AlphaOptions = {}, ammoByType = ammoIndex(ix)): AlphaBuild | null {
  const found = searchAlpha(mech, ix, opts, ammoByType);
  return found.best ? { ...withActuators(found.best, ix), proven: found.stats.complete } : null;
}

type Found = { build: Build; a: Analysis };

/** The search removes all deselectable actuators; this puts back those that still fit, lower arm before hand. */
function withActuators(found: Found, ix: GameIndex): Found {
  let { build, a } = found;
  for (const [comp, removed] of Object.entries(build.removedActuators)) {
    // Removed in the order of the internals: try putting back all, then all but the last (the hand)
    for (let keep = 0; keep < removed.length; keep++) {
      const trial: Build = { ...build, removedActuators: { ...build.removedActuators, [comp]: removed.slice(removed.length - keep) } };
      const ta = analyze(trial, ix);
      if (ta.issues.length === 0 && Math.abs(ta.alpha - a.alpha) < 1e-9) {
        build = trial;
        a = ta;
        break;
      }
    }
  }
  return { build, a };
}

function searchAlpha(mech: Mech, ix: GameIndex, opts: AlphaOptions, ammoByType: Map<string, Ammo[]>) {
  const stats: SearchStats = { complete: true };
  let best: Found | null = null;
  const consider = (r: { build: Build; a: Analysis } | null) => {
    if (r && (!best || r.a.alpha > best.a.alpha + 1e-9 || (Math.abs(r.a.alpha - best.a.alpha) <= 1e-9 && r.a.heat.alphaTotal < best.a.heat.alphaTotal))) best = r;
  };
  const target = () => (best ? best.a.alpha : 0);
  const singleSinks = (faction: Faction) => [...ix.upgrades.values()].find((u) => u.type === 'HeatSink' && factionMatches(u.faction, faction) && ix.items.get(u.compatibleHeatSink ?? -1)?.name === 'HeatSink_MkI');

  if (mech.isOmni) {
    const ch = ix.chassis.get(mech.chassis);
    const stock = stockBuild(mech.variant, ix).pods;
    const swappable = mech.components.filter((c) => c.omniSlot && c.podId === null).map((c) => c.name);
    // Pods that differ only in name behave the same
    const options = new Map<string, Pod[]>();
    for (const comp of swappable) {
      const seen = new Map<string, Pod>();
      for (const set of ch?.sets ?? []) {
        const pod = set.pods[comp];
        if (!pod) continue;
        const sig = JSON.stringify([pod.hardpoints.map((h) => [h.type, h.count]), pod.internals, pod.fixed, pod.canEquipECM, pod.quirks.map((q) => [q.key, q.value]), ch!.sets.find((x) => x.name === pod.set)!.bonuses.length ? pod.set : '']);
        if (!seen.has(sig) || pod.id === stock[comp]) seen.set(sig, pod);
      }
      options.set(comp, [...seen.values()]);
    }
    const quickCache = new Map<string, number>();
    const quick = (pods: Record<string, number>) => {
      const key = swappable.map((c) => pods[c]).join(',');
      let v = quickCache.get(key);
      if (v === undefined) {
        v = evaluate(mech, skeleton(mech, pods, ix, null, null), ix, opts, ammoByType, 0, QUICK_NODES, { complete: true })?.a.alpha ?? 0;
        quickCache.set(key, v);
      }
      return v;
    };
    // Starting points: the variant's own pods and every complete set
    const starts: Record<string, number>[] = [{ ...stock }];
    for (const set of ch?.sets ?? []) {
      const pods = { ...stock };
      for (const comp of swappable) if (set.pods[comp]) pods[comp] = set.pods[comp]!.id;
      starts.push(pods);
    }
    starts.sort((x, y) => quick(y) - quick(x));
    const finals: Record<string, number>[] = [];
    for (const start of starts.slice(0, OMNI_STARTS)) {
      let pods = start;
      let value = quick(pods);
      for (let pass = 0; pass < 3; pass++) {
        let improved = false;
        for (const comp of swappable) {
          for (const pod of options.get(comp) ?? []) {
            if (pod.id === pods[comp]) continue;
            const trial = { ...pods, [comp]: pod.id };
            const v = quick(trial);
            if (v > value + 1e-9) {
              pods = trial;
              value = v;
              improved = true;
            }
          }
        }
        if (!improved) break;
      }
      finals.push(pods);
    }
    finals.sort((x, y) => quick(y) - quick(x));
    // The pods come from a heuristic, so an omnimech's result is never proven best
    stats.complete = false;
    for (const pods of finals) consider(evaluate(mech, skeleton(mech, pods, ix, null, null), ix, opts, ammoByType, target(), FULL_NODES, stats));
    return { best: best as Found | null, stats };
  }

  const ups = (type: Upgrade['type']) => [...ix.upgrades.values()].filter((u) => u.type === type && factionMatches(u.faction, mech.faction));
  const armors = ups('Armor').filter((u) => (u.armorPerTon ?? 0) > 0 && !u.fixedSlotsPerComponent);
  const structures = ups('Structure');
  const hs = singleSinks(mech.faction) ?? ups('HeatSink')[0];
  const speedMul = mech.quirks.filter((q) => q.stat === 'mechtopspeed' && q.kind === 'multiplier').reduce((s, q) => s + q.value, 0);
  const engines = engineCandidates(mech, ix, opts.minSpeed ?? 0, speedMul);
  const configs: { build: Build; tons: number }[] = [];
  for (const armor of armors) {
    for (const structure of structures) {
      for (const engine of engines) {
        const build = skeleton(mech, {}, ix, { armor: armor.id, structure: structure.id, heatSink: hs!.id }, engine.id);
        const a = analyze(build, ix);
        configs.push({ build, tons: a.tonsMax - a.tonsUsed });
      }
    }
  }
  // Most free tonnage first, so the bound prunes the others early
  configs.sort((x, y) => y.tons - x.tons);
  // First a short search per configuration for a good incumbent, then the full search that has to beat it
  for (const c of configs) consider(evaluate(mech, c.build, ix, opts, ammoByType, target(), QUICK_NODES, { complete: true }));
  for (const c of configs) consider(evaluate(mech, c.build, ix, opts, ammoByType, target(), FULL_NODES, stats));
  return { best: best as Found | null, stats };
}

export function alphaRow(mech: Mech, r: AlphaBuild, ix: GameIndex): AlphaRow {
  const weapons = r.a.weapons.filter((w) => w.weapon.hardpoint !== 'ams').map((w) => ({ name: w.weapon.name, label: w.weapon.label, hardpoint: w.weapon.hardpoint, count: w.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const code = encodeBuildCode(r.build, mech, ix);
  return {
    variant: mech.variant, label: mech.label, chassis: mech.chassis, faction: mech.faction, tons: mech.tons, weightClass: mech.weightClass, isOmni: mech.isOmni,
    alpha: r.a.alpha, heat: r.a.heat.alphaTotal, ghost: r.a.heat.ghost, capacity: r.a.heatCapacity, speed: r.a.speed, proven: r.proven,
    weapons, build: r.build, code: code.code, alsoVariants: [],
  };
}

/** Best alpha for every mech (test mechs and special variants excluded). Slow: about a third of a second per mech. */
export function computeAlphaRows(ix: GameIndex, opts: AlphaOptions, onProgress?: (done: number, total: number) => void): AlphaRow[] {
  const ammoByType = ammoIndex(ix);
  const mechs = [...ix.mechs.values()].filter((m) => !m.special);
  const rows: AlphaRow[] = [];
  mechs.forEach((m, i) => {
    const r = bestAlpha(m, ix, opts, ammoByType);
    if (r) rows.push(alphaRow(m, r, ix));
    onProgress?.(i + 1, mechs.length);
  });
  return rows;
}

/** Filters and sorts computed rows, best first; omnimechs once per chassis, identical battlemech variants merged. */
export function rankAlphaRows(all: AlphaRow[], q: Pick<AlphaQuery, 'filters' | 'limit'>, ix: GameIndex): AlphaResult {
  const found = all.filter((r) => {
    const m = ix.mechs.get(r.variant);
    return !!m && matchesStatic(m, q.filters);
  }).map((r) => ({ ...r, alsoVariants: [] as string[] }));
  found.sort((a, b) => b.alpha - a.alpha || a.heat - b.heat || a.label.localeCompare(b.label));
  const rows: AlphaRow[] = [];
  const seen = new Map<string, AlphaRow>();
  for (const row of found) {
    const key = row.isOmni ? `omni:${row.chassis}` : `${row.chassis}|${row.alpha.toFixed(4)}|${row.heat.toFixed(4)}|${JSON.stringify(row.weapons)}`;
    const first = seen.get(key);
    if (first) first.alsoVariants.push(row.variant);
    else {
      seen.set(key, row);
      rows.push(row);
    }
  }
  return { total: rows.length, rows: rows.slice(0, q.limit ?? 200) };
}

/** Stable key of the options that change the computation */
/** Raise when the search or the rules change, so cached rankings are recalculated */
export const ALPHA_VERSION = 2;

export const alphaOptionsKey = (o: AlphaOptions) => JSON.stringify([ALPHA_VERSION, !!o.mixGhostGroups, [...(o.hardpointTypes ?? [])].sort(), o.minRange ?? 0, o.minSpeed ?? 0]);
