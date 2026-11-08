import { factionMatches, quirkAppliesToWeapon } from './quirks.ts';
import { activeQuirks, ASSUMPTIONS, resolveComponent, weaponStats, weaponStatsFrom, type GameIndex, type ResolvedComponent, type SourcedQuirk, type WeaponStats } from './rules.ts';
import { matchesStatic, type PodChoice, type SearchFilters } from './search.ts';
import { HARDPOINT_TYPES, type Chassis, type Faction, type HardpointType, type Mech, type Pod, type Quirk, type Weapon, type WeightClass } from './types.ts';

export const WEAPON_STAT_KEYS = ['maxRange', 'optimalRange', 'damage', 'cooldown', 'duration', 'heat', 'velocity', 'dps', 'hps'] as const;
export type WeaponStatKey = (typeof WEAPON_STAT_KEYS)[number];

/**
 * The quirk stats a value depends on, and in which direction they improve it.
 * Only these decide the best pod selection.
 */
const STAT_INPUTS: Record<WeaponStatKey, Record<string, 1 | -1>> = {
  maxRange: { range: 1 }, optimalRange: { range: 1 }, damage: { damage: 1 }, cooldown: { cooldown: -1 }, duration: { duration: -1 }, heat: { heat: -1 },
  velocity: { velocity: 1 }, dps: { damage: 1, cooldown: -1, duration: -1, rof: 1 }, hps: { heat: -1, cooldown: 1, duration: 1 },
};
const LOWER_IS_BETTER = new Set<WeaponStatKey>(['cooldown', 'duration', 'heat', 'hps']);
export const weaponStatLowerIsBetter = (key: WeaponStatKey) => LOWER_IS_BETTER.has(key);

const statValues = (s: WeaponStats): Record<WeaponStatKey, number> => ({
  maxRange: s.maxRange, optimalRange: s.optimalRange, damage: s.damage, cooldown: s.cooldown, duration: s.duration,
  heat: s.heat, velocity: s.velocity, dps: s.dps, hps: s.hps,
});
/** A weapon's values without quirks. */
export const baseWeaponStats = (w: Weapon) => statValues(weaponStats(w, 1, []));

export interface WeaponQuery {
  /** One weapon per faction, see `weaponFamilies` */
  weapons: string[];
  sortBy: WeaponStatKey;
  /** At least this many copies of the weapon must fit */
  minCount?: number;
  filters: Pick<SearchFilters, 'text' | 'faction' | 'weightClasses' | 'minTons' | 'maxTons' | 'requireJumpJets' | 'omni'>;
  limit?: number;
}

export interface WeaponRow {
  variant: string;
  label: string;
  chassis: string;
  faction: Faction;
  tons: number;
  weightClass: WeightClass;
  isOmni: boolean;
  variantType: string | null;
  hardpoints: Record<HardpointType, number>;
  weaponId: number;
  /** Copies the hardpoints and slots allow. Weight is not considered. */
  mountable: number;
  stats: Record<WeaponStatKey, number>;
  sources: SourcedQuirk[];
  pods: PodChoice[];
  alsoVariants: string[];
}
export interface WeaponResult { total: number; rows: WeaponRow[] }

/** Engine slots the mech cannot avoid: exact with a fixed engine, otherwise only the centre torso of the stock engine. */
function engineSlotsOf(mech: Mech, ix: GameIndex) {
  const fixed = mech.components.flatMap((c) => resolveComponent(c, { pods: {} }, ix).fixed).map((id) => ix.items.get(id)).find((i) => i?.kind === 'engine');
  if (fixed?.kind === 'engine') return { centre: fixed.slots, side: fixed.sideSlots };
  const stock = ix.loadouts.get(mech.variant)?.components.flatMap((c) => c.ordered).map((id) => ix.items.get(id)).find((i) => i?.kind === 'engine');
  return { centre: stock?.slots ?? 0, side: 0 };
}

/** How many copies fit in the component? Deselectable actuators count as deselected. */
function mountableIn(c: ResolvedComponent, w: Weapon, engine: { centre: number; side: number }, ix: GameIndex): number {
  if (w.components.length > 0 && !w.components.includes(c.name)) return 0;
  const hardpoints = c.hardpoints.filter((h) => h.type === w.hardpoint).reduce((a, h) => a + h.count, 0);
  if (hardpoints === 0) return 0;
  let used = c.name === 'centre_torso' ? engine.centre : c.name === 'left_torso' || c.name === 'right_torso' ? engine.side : 0;
  for (const r of c.internals) if (!r.toggleable) used += ix.items.get(r.id)?.slots ?? 0;
  for (const id of c.fixed) {
    const item = ix.items.get(id);
    // Fixed heat sinks in the centre torso sit in the engine
    if (item && item.kind !== 'engine' && !(item.kind === 'heatsink' && c.name === 'centre_torso')) used += item.slots;
  }
  return w.slots > 0 ? Math.min(hardpoints, Math.max(0, Math.floor((c.slots - used) / w.slots))) : hardpoints;
}

/** How many copies of the weapon do the hardpoints and slots allow? */
export function mountableCount(mech: Mech, pods: Record<string, number>, w: Weapon, ix: GameIndex): number {
  const engine = engineSlotsOf(mech, ix);
  const count = mech.components.reduce((a, def) => a + mountableIn(resolveComponent(def, { pods }, ix), w, engine, ix), 0);
  return Math.min(count, ASSUMPTIONS.maxWeapons);
}

interface PodState { sums: number[]; sets: number[]; count: number; pods: Record<string, number> }
interface Scored { pods: Record<string, number>; count: number; value: number }

/** Drops states that, for the same set pieces, are better in no sum and not in the count. They can never win. */
function withoutDominated(states: Map<string, PodState>, better: number[]): Map<string, PodState> {
  const groups = new Map<string, [string, PodState][]>();
  for (const entry of states) {
    const key = entry[1].sets.join();
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const atLeast = (a: PodState, b: PodState) => a.count >= b.count && a.sums.every((x, i) => (x - b.sums[i]!) * better[i]! >= -1e-9);
  const out = new Map<string, PodState>();
  for (const group of groups.values()) {
    const kept: [string, PodState][] = [];
    for (const entry of group) {
      if (kept.some(([, k]) => atLeast(k, entry[1]))) continue;
      for (let i = kept.length - 1; i >= 0; i--) if (atLeast(entry[1], kept[i]![1])) kept.splice(i, 1);
      kept.push(entry);
    }
    for (const [key, st] of kept) out.set(key, st);
  }
  return out;
}

/**
 * Best pods for one value. Considers all combinations, merging those with the same quirk sums,
 * the same set pieces and the same count; the result therefore stays exact.
 */
function bestPods(mech: Mech, ch: Chassis, w: Weapon, sortBy: WeaponStatKey, need: number, sign: number, ix: GameIndex): Scored | null {
  const inputs = STAT_INPUTS[sortBy];
  const dims = Object.keys(inputs).flatMap((stat) => (['multiplier', 'additive'] as const).map((kind) => ({ stat, kind, better: inputs[stat]! })));
  const relevant = (q: Quirk) => q.stat in inputs && quirkAppliesToWeapon(q, w, true);
  const deltas = (quirks: Quirk[]) => {
    const out = dims.map(() => 0);
    for (const q of quirks) if (relevant(q)) out[dims.findIndex((d) => d.stat === q.stat && d.kind === q.kind)]! += q.value;
    return out;
  };
  const trackedSets = ch.sets.filter((s) => s.bonuses.some((b) => b.quirks.some(relevant)));
  const bonuses = trackedSets.flatMap((s, set) => s.bonuses.map((b) => ({ set, pieces: b.pieces, sums: deltas(b.quirks) })));
  const engine = engineSlotsOf(mech, ix);

  const start: PodState = { sums: deltas(mech.quirks), sets: trackedSets.map(() => 0), count: 0, pods: {} };
  const choices: { comp: string; id: number; sums: number[]; set: number; count: number }[][] = [];
  for (const def of mech.components) {
    if (def.omniSlot && def.podId === null) {
      const pods = ch.sets.map((s) => s.pods[def.name]).filter((p): p is Pod => !!p);
      if (pods.length > 0) {
        choices.push(pods.map((pod) => ({
          comp: def.name, id: pod.id, sums: deltas(pod.quirks), set: trackedSets.findIndex((s) => s.name === pod.set),
          count: mountableIn(resolveComponent(def, { pods: { [def.name]: pod.id } }, ix), w, engine, ix),
        })));
      }
      continue;
    }
    const part = resolveComponent(def, { pods: {} }, ix);
    start.count += mountableIn(part, w, engine, ix);
    if (part.pod) {
      deltas(part.pod.quirks).forEach((x, i) => { start.sums[i]! += x; });
      const set = trackedSets.findIndex((s) => s.name === part.pod!.set);
      if (set >= 0) start.sets[set]!++;
    }
  }

  let states = new Map<string, PodState>([['', start]]);
  for (const options of choices) {
    const next = new Map<string, PodState>();
    for (const st of states.values()) {
      for (const o of options) {
        const sums = st.sums.map((x, i) => x + o.sums[i]!);
        const sets = o.set >= 0 ? st.sets.map((n, i) => (i === o.set ? n + 1 : n)) : st.sets;
        const count = st.count + o.count;
        const key = `${sums.map((x) => x.toFixed(6)).join()}|${sets.join()}|${count}`;
        if (!next.has(key)) next.set(key, { sums, sets, count, pods: { ...st.pods, [o.comp]: o.id } });
      }
    }
    states = withoutDominated(next, dims.map((d) => d.better));
  }

  let best: Scored | null = null;
  for (const st of states.values()) {
    const count = Math.min(st.count, ASSUMPTIONS.maxWeapons);
    if (count < need) continue;
    const sums = [...st.sums];
    for (const b of bonuses) if (st.sets[b.set]! >= b.pieces) b.sums.forEach((x, i) => { sums[i]! += x; });
    const quirks = dims.map((d, i) => ({ quirk: { stat: d.stat, kind: d.kind, value: sums[i]! } as Quirk, source: { kind: 'mech' as const } }));
    const value = statValues(weaponStatsFrom(w, count, quirks))[sortBy] * sign;
    if (!best || value > best.value + 1e-9 || (Math.abs(value - best.value) <= 1e-9 && count > best.count)) best = { pods: st.pods, count, value };
  }
  return best;
}

/** Scores the weapon on the mech; omnimechs with the best pods for `sortBy`. Null if it does not fit often enough. */
export function evaluateWeaponOnMech(mech: Mech, w: Weapon, sortBy: WeaponStatKey, minCount: number, ix: GameIndex): WeaponRow | null {
  const ch = mech.isOmni ? ix.chassis.get(mech.chassis) : undefined;
  const need = Math.max(1, minCount);
  const sign = LOWER_IS_BETTER.has(sortBy) ? -1 : 1;
  let pods: Record<string, number> = {};
  if (ch) {
    const found = bestPods(mech, ch, w, sortBy, need, sign, ix);
    if (!found) return null;
    pods = found.pods;
  }
  const mountable = mountableCount(mech, pods, w, ix);
  if (mountable < need) return null;
  const best = { pods, mountable, stats: weaponStats(w, mountable, activeQuirks({ variant: mech.variant, pods, skills: {} }, ix)) };

  const hardpoints = Object.fromEntries(HARDPOINT_TYPES.map((t) => [t, 0])) as Record<HardpointType, number>;
  const choices: PodChoice[] = [];
  for (const def of mech.components) {
    const part = resolveComponent(def, { pods: best.pods }, ix);
    for (const h of part.hardpoints) hardpoints[h.type] += h.count;
    if (part.pod && best.pods[def.name] !== undefined) choices.push({ component: def.name, podId: part.pod.id, set: part.pod.set });
  }
  return {
    variant: mech.variant, label: mech.label, chassis: mech.chassis, faction: mech.faction, tons: mech.tons, weightClass: mech.weightClass,
    isOmni: mech.isOmni, variantType: mech.variantType, hardpoints, weaponId: w.id, mountable: best.mountable,
    stats: statValues(best.stats), sources: best.stats.sources, pods: choices, alsoVariants: [],
  };
}

/** One weapon compared across all mechs that can carry it. Sorted by the selected value, best first. */
export function weaponOverview(q: WeaponQuery, ix: GameIndex): WeaponResult {
  const weapons = q.weapons.map((name) => [...ix.items.values()].find((i): i is Weapon => i.kind === 'weapon' && i.name === name)).filter((w): w is Weapon => !!w);
  const sign = LOWER_IS_BETTER.has(q.sortBy) ? -1 : 1;
  const found: WeaponRow[] = [];
  for (const mech of ix.mechs.values()) {
    if (!matchesStatic(mech, q.filters)) continue;
    const w = weapons.find((x) => factionMatches(x.faction, mech.faction));
    if (!w) continue;
    const row = evaluateWeaponOnMech(mech, w, q.sortBy, q.minCount ?? 1, ix);
    if (row) found.push(row);
  }
  found.sort((a, b) => (b.stats[q.sortBy] - a.stats[q.sortBy]) * sign || b.mountable - a.mountable || a.label.localeCompare(b.label));

  // Only the best variant per omni chassis; merge identical variants.
  const rows: WeaponRow[] = [];
  const seen = new Map<string, WeaponRow>();
  for (const row of found) {
    const key = row.isOmni ? `omni:${row.chassis}` : JSON.stringify([row.chassis, row.weaponId, row.mountable, row.hardpoints, row.stats]);
    const first = seen.get(key);
    if (first) first.alsoVariants.push(row.variant);
    else {
      seen.set(key, row);
      rows.push(row);
    }
  }
  return { total: rows.length, rows: rows.slice(0, q.limit ?? 200) };
}
