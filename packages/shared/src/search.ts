import type { QuirkSource } from './i18n.ts';
import { lowerIsBetter, quirkAppliesToWeapon } from './quirks.ts';
import { resolveComponent, type GameIndex } from './rules.ts';
import {
  HARDPOINT_TYPES,
  type Chassis, type Faction, type HardpointType, type Mech, type Pod, type Quirk, type Weapon, type WeightClass,
} from './types.ts';

export type MechField = 'tons' | 'maxEngine' | 'maxJumpJets' | 'maxSpeed' | 'torsoYaw' | 'torsoYawSpeed' | 'armYaw';

export type Criterion =
  | { kind: 'hardpoints'; type: HardpointType; dir?: SortDir }
  /** Exact quirk, e.g. `heatdissipation_multiplier` */
  | { kind: 'quirk'; key: string; dir?: SortDir }
  /** Sum of all quirks on a stat that apply to a weapon. Per faction, the first matching weapon counts. */
  | { kind: 'weaponQuirk'; weapons: string[]; stat: string; includeGlobal?: boolean; dir?: SortDir }
  | { kind: 'mech'; field: MechField; dir?: SortDir };
export type SortDir = 'asc' | 'desc';

export interface SearchFilters {
  text?: string;
  faction?: Faction;
  weightClasses?: WeightClass[];
  minTons?: number;
  maxTons?: number;
  minHardpoints?: Partial<Record<HardpointType, number>>;
  requireECM?: boolean;
  requireJumpJets?: boolean;
  omni?: 'any' | 'only' | 'none';
  /** Only mechs where at least one quirk criterion has a value */
  requireQuirkMatch?: boolean;
  includeSpecial?: boolean;
}
export interface SearchQuery { filters: SearchFilters; criteria: Criterion[]; limit?: number }

export interface ValueSource { source: QuirkSource; raw: string; value: number; kind: Quirk['kind'] }
export interface CriterionValue { value: number; kind: 'count' | 'multiplier' | 'additive' | 'number'; sources: ValueSource[] }
export interface PodChoice { component: string; podId: number; set: string }

export interface SearchRow {
  variant: string;
  label: string;
  chassis: string;
  faction: Faction;
  tons: number;
  weightClass: WeightClass;
  isOmni: boolean;
  variantType: string | null;
  hardpoints: Record<HardpointType, number>;
  canEquipECM: boolean;
  maxJumpJets: number;
  values: CriterionValue[];
  /** Best pod selection (omnimechs only) */
  pods: PodChoice[];
  /** Further variants with identical values */
  alsoVariants: string[];
}
export interface SearchResult { total: number; rows: SearchRow[] }

export const defaultDir = (c: Criterion): SortDir => {
  if (c.dir) return c.dir;
  if (c.kind === 'weaponQuirk') return lowerIsBetter(c.stat) ? 'asc' : 'desc';
  if (c.kind === 'quirk') return lowerIsBetter(c.key.replace(/_(multiplier|additive)$/, '').split('_').pop() ?? '') ? 'asc' : 'desc';
  return 'desc';
};

const maxSpeedOf = (m: Mech) => m.maxEngine / m.tons * m.movement.maxSpeedFactor;
const mechFieldValue = (m: Mech, f: MechField): number => {
  switch (f) {
    case 'tons': return m.tons;
    case 'maxEngine': return m.maxEngine;
    case 'maxJumpJets': return m.maxJumpJets;
    case 'maxSpeed': return maxSpeedOf(m);
    case 'torsoYaw': return m.movement.torsoYaw;
    case 'torsoYawSpeed': return m.movement.torsoYawSpeed;
    case 'armYaw': return m.movement.armYaw;
  }
};

/** First weapon in the list that matches the faction. */
function weaponFor(names: string[], faction: Faction, ix: GameIndex, cache: Map<string, Weapon | null>): Weapon | null {
  const key = `${faction}|${names.join(',')}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const set = new Set(names);
  let found: Weapon | null = null;
  for (const name of names) {
    for (const i of ix.items.values()) {
      if (i.kind === 'weapon' && i.name === name && set.has(i.name) && (i.faction === 'Both' || i.faction === faction)) {
        found = i;
        break;
      }
    }
    if (found) break;
  }
  cache.set(key, found);
  return found;
}

interface Scorer {
  /** Contribution of a quirk per criterion */
  quirkHits: (q: Quirk) => number[];
  criteria: Criterion[];
}

function makeScorer(criteria: Criterion[], faction: Faction, ix: GameIndex, cache: Map<string, Weapon | null>): Scorer {
  const weapons = criteria.map((c) => (c.kind === 'weaponQuirk' ? weaponFor(c.weapons, faction, ix, cache) : null));
  return {
    criteria,
    quirkHits: (q) => criteria.map((c, i) => {
      if (c.kind === 'quirk') return q.key === c.key ? 1 : 0;
      if (c.kind === 'weaponQuirk') {
        const w = weapons[i];
        return w && q.stat === c.stat && quirkAppliesToWeapon(q, w, !!c.includeGlobal) ? 1 : 0;
      }
      return 0;
    }),
  };
}

/** Sign per criterion, so that "higher is better" holds for the comparison. */
const signs = (criteria: Criterion[]) => criteria.map((c) => (defaultDir(c) === 'asc' ? -1 : 1));

function compareVec(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (Math.abs(d) > 1e-9) return d;
  }
  return 0;
}

interface Contribution {
  vec: number[];
  hp: Record<HardpointType, number>;
  ecm: number;
}

function contribution(hardpoints: Pod['hardpoints'], quirks: Quirk[], ecm: boolean, scorer: Scorer, sgn: number[]): Contribution {
  const vec = sgn.map(() => 0);
  const hp = { ballistic: 0, energy: 0, missile: 0, ams: 0 };
  for (const h of hardpoints) hp[h.type] += h.count;
  scorer.criteria.forEach((c, i) => {
    if (c.kind === 'hardpoints') vec[i] = (vec[i] ?? 0) + hp[c.type] * (sgn[i] ?? 1);
  });
  for (const q of quirks) {
    scorer.quirkHits(q).forEach((hit, i) => {
      if (hit) vec[i] = (vec[i] ?? 0) + q.value * (sgn[i] ?? 1);
    });
  }
  return { vec, hp, ecm: ecm ? 1 : 0 };
}

const addVec = (a: number[], b: number[]) => a.map((x, i) => x + (b[i] ?? 0));

interface Selection { pods: Map<string, Pod>; vec: number[] }

/**
 * Best pod selection for an omnimech. The components' contributions are additive, so dynamic
 * programming over the components yields the exact solution; the state is the hardpoints capped
 * at the minimum requirement. Set bonuses are checked by forcing the required pieces.
 */
function optimizePods(
  mech: Mech, ch: Chassis, scorer: Scorer, sgn: number[],
  base: { hp: Record<HardpointType, number>; ecm: number },
  need: Partial<Record<HardpointType, number>>, needEcm: boolean, ctPod: Pod | null,
): Selection | null {
  const swappable = mech.components.filter((c) => c.omniSlot && c.podId === null).map((c) => c.name);

  const solve = (forced: Map<string, Pod>): Selection | null => {
    const capped = (hp: Record<HardpointType, number>, ecm: number) =>
      HARDPOINT_TYPES.map((t) => Math.min(hp[t], need[t] ?? 0)).join(',') + `|${needEcm ? Math.min(ecm, 1) : 0}`;
    interface State { vec: number[]; hp: Record<HardpointType, number>; ecm: number; pods: Map<string, Pod> }
    let states = new Map<string, State>();
    states.set(capped(base.hp, base.ecm), { vec: sgn.map(() => 0), hp: base.hp, ecm: base.ecm, pods: new Map() });
    for (const comp of swappable) {
      const options = forced.has(comp) ? [forced.get(comp)!] : ch.sets.map((s) => s.pods[comp]).filter((p): p is Pod => !!p);
      if (options.length === 0) continue;
      const next = new Map<string, State>();
      for (const st of states.values()) {
        for (const pod of options) {
          const c = contribution(pod.hardpoints, pod.quirks, pod.canEquipECM, scorer, sgn);
          const hp = { ...st.hp };
          for (const t of HARDPOINT_TYPES) hp[t] += c.hp[t];
          const ecm = st.ecm + c.ecm;
          const vec = addVec(st.vec, c.vec);
          const k = capped(hp, ecm);
          const prev = next.get(k);
          if (!prev || compareVec(vec, prev.vec) > 0) next.set(k, { vec, hp, ecm, pods: new Map(st.pods).set(comp, pod) });
        }
      }
      states = next;
    }
    let best: State | null = null;
    for (const st of states.values()) {
      const ok = HARDPOINT_TYPES.every((t) => st.hp[t] >= (need[t] ?? 0)) && (!needEcm || st.ecm >= 1);
      if (ok && (!best || compareVec(st.vec, best.vec) > 0)) best = st;
    }
    return best ? { pods: best.pods, vec: best.vec } : null;
  };

  const bonusVec = (pods: Map<string, Pod>) => {
    const count = new Map<string, number>();
    for (const p of pods.values()) count.set(p.set, (count.get(p.set) ?? 0) + 1);
    if (ctPod) count.set(ctPod.set, (count.get(ctPod.set) ?? 0) + 1);
    let v = sgn.map(() => 0);
    for (const s of ch.sets) {
      for (const b of s.bonuses) {
        if ((count.get(s.name) ?? 0) >= b.pieces) v = addVec(v, contribution([], b.quirks, false, scorer, sgn).vec);
      }
    }
    return v;
  };

  let best: Selection | null = null;
  const consider = (sel: Selection | null) => {
    if (!sel) return;
    const total = addVec(sel.vec, bonusVec(sel.pods));
    if (!best || compareVec(total, best.vec) > 0) best = { pods: sel.pods, vec: total };
  };
  consider(solve(new Map()));
  for (const s of ch.sets) {
    const available = swappable.filter((c) => s.pods[c]);
    const inCt = ctPod?.set === s.name ? 1 : 0;
    for (const b of s.bonuses) {
      const k = b.pieces - inCt;
      if (k < 0 || k > available.length) continue;
      for (const subset of combinations(available, k)) {
        consider(solve(new Map(subset.map((c) => [c, s.pods[c]!]))));
      }
    }
  }
  return best;
}

function combinations<T>(xs: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (xs.length < k) return [];
  const [head, ...rest] = xs as [T, ...T[]];
  return [...combinations(rest, k - 1).map((c) => [head, ...c]), ...combinations(rest, k)];
}

export interface EvaluatedMech { row: SearchRow; vec: number[] }

/** Scores a mech; omnimechs with the best pod selection. Null if the minimum requirement cannot be met. */
export function evaluateMech(mech: Mech, query: SearchQuery, ix: GameIndex, cache = new Map<string, Weapon | null>()): EvaluatedMech | null {
  const { criteria, filters } = query;
  const sgn = signs(criteria);
  const scorer = makeScorer(criteria, mech.faction, ix, cache);
  const need = filters.minHardpoints ?? {};
  const needEcm = !!filters.requireECM;

  const baseHp: Record<HardpointType, number> = { ballistic: 0, energy: 0, missile: 0, ams: 0 };
  let baseEcm = mech.canEquipECM ? 1 : 0;
  let ctPod: Pod | null = null;
  for (const def of mech.components) {
    if (def.omniSlot && def.podId === null) continue;
    const r = resolveComponent(def, { pods: {} }, ix);
    if (def.podId !== null) ctPod = r.pod;
    if (r.canEquipECM) baseEcm = 1;
    for (const h of r.hardpoints) baseHp[h.type] += h.count;
  }

  let pods = new Map<string, Pod>();
  const ch = mech.isOmni ? ix.chassis.get(mech.chassis) : undefined;
  if (ch) {
    const sel = optimizePods(mech, ch, scorer, sgn, { hp: baseHp, ecm: baseEcm }, need, needEcm, ctPod);
    if (!sel) return null;
    pods = sel.pods;
  }

  // Final values with their source
  const hp = { ...baseHp };
  let ecm = baseEcm;
  const quirks: { quirk: Quirk; source: QuirkSource }[] = mech.quirks.map((quirk) => ({ quirk, source: { kind: 'mech' } }));
  const counts = new Map<string, number>();
  const addPod = (p: Pod, addHp: boolean) => {
    counts.set(p.set, (counts.get(p.set) ?? 0) + 1);
    if (addHp) for (const h of p.hardpoints) hp[h.type] += h.count;
    if (p.canEquipECM) ecm = 1;
    for (const quirk of p.quirks) quirks.push({ quirk, source: { kind: 'pod', set: p.set } });
  };
  if (ctPod) addPod(ctPod, false);
  for (const p of pods.values()) addPod(p, true);
  if (ch) {
    for (const s of ch.sets) {
      for (const b of s.bonuses) {
        if ((counts.get(s.name) ?? 0) >= b.pieces) {
          for (const quirk of b.quirks) quirks.push({ quirk, source: { kind: 'set', set: s.name, pieces: b.pieces } });
        }
      }
    }
  }
  if (HARDPOINT_TYPES.some((t) => hp[t] < (need[t] ?? 0)) || (needEcm && ecm < 1)) return null;

  const values: CriterionValue[] = criteria.map((c, i) => {
    if (c.kind === 'hardpoints') return { value: hp[c.type], kind: 'count', sources: [] };
    if (c.kind === 'mech') return { value: mechFieldValue(mech, c.field), kind: 'number', sources: [] };
    const hits = quirks.filter(({ quirk }) => scorer.quirkHits(quirk)[i]);
    return {
      value: hits.reduce((a, { quirk }) => a + quirk.value, 0),
      kind: hits[0]?.quirk.kind ?? 'multiplier',
      sources: hits.map(({ quirk, source }) => ({ source, raw: quirk.raw, value: quirk.value, kind: quirk.kind })),
    };
  });
  const vec = values.map((v, i) => v.value * (sgn[i] ?? 1));

  return {
    vec,
    row: {
      variant: mech.variant, label: mech.label, chassis: mech.chassis, faction: mech.faction, tons: mech.tons,
      weightClass: mech.weightClass, isOmni: mech.isOmni, variantType: mech.variantType,
      hardpoints: hp, canEquipECM: ecm > 0, maxJumpJets: mech.maxJumpJets, values,
      pods: [...pods.values()].map((p) => ({ component: p.component, podId: p.id, set: p.set })),
      alsoVariants: [],
    },
  };
}

export function matchesStatic(m: Mech, f: SearchFilters): boolean {
  if (m.special && !f.includeSpecial) return false;
  if (f.faction && m.faction !== f.faction) return false;
  if (f.weightClasses?.length && !f.weightClasses.includes(m.weightClass)) return false;
  if (f.minTons !== undefined && m.tons < f.minTons) return false;
  if (f.maxTons !== undefined && m.tons > f.maxTons) return false;
  if (f.requireJumpJets && m.maxJumpJets <= 0) return false;
  if (f.omni === 'only' && !m.isOmni) return false;
  if (f.omni === 'none' && m.isOmni) return false;
  if (f.text) {
    const t = f.text.toLowerCase();
    if (!m.label.toLowerCase().includes(t) && !m.variant.includes(t) && !m.chassis.includes(t)) return false;
  }
  return true;
}

const signature = (r: SearchRow) => JSON.stringify([r.chassis, r.hardpoints, r.values.map((v) => v.value), r.canEquipECM, r.maxJumpJets]);

export function searchMechs(query: SearchQuery, ix: GameIndex): SearchResult {
  const cache = new Map<string, Weapon | null>();
  const evaluated: EvaluatedMech[] = [];
  for (const m of ix.mechs.values()) {
    if (!matchesStatic(m, query.filters)) continue;
    const e = evaluateMech(m, query, ix, cache);
    if (!e) continue;
    if (query.filters.requireQuirkMatch) {
      const hasQuirkCriterion = query.criteria.some((c) => c.kind === 'quirk' || c.kind === 'weaponQuirk');
      const hit = e.row.values.some((v, i) => {
        const c = query.criteria[i]!;
        return (c.kind === 'quirk' || c.kind === 'weaponQuirk') && v.value !== 0;
      });
      if (hasQuirkCriterion && !hit) continue;
    }
    evaluated.push(e);
  }

  evaluated.sort((a, b) => compareVec(b.vec, a.vec) || a.row.label.localeCompare(b.row.label));

  // Only the best variant per omni chassis; merge identical variants.
  const rows: SearchRow[] = [];
  const seen = new Map<string, SearchRow>();
  const omniSeen = new Map<string, SearchRow>();
  for (const { row } of evaluated) {
    if (row.isOmni) {
      const first = omniSeen.get(row.chassis);
      if (first) {
        first.alsoVariants.push(row.variant);
        continue;
      }
      omniSeen.set(row.chassis, row);
      rows.push(row);
      continue;
    }
    const sig = signature(row);
    const first = seen.get(sig);
    if (first) {
      first.alsoVariants.push(row.variant);
      continue;
    }
    seen.set(sig, row);
    rows.push(row);
  }
  return { total: rows.length, rows: rows.slice(0, query.limit ?? 200) };
}
