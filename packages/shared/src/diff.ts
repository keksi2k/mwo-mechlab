import type { Dataset, Item, Quirk, Weapon } from './types.ts';

/** What changed between two extracted game versions. */
export interface QuirkChange {
  /** Raw quirk name */
  raw: string;
  label: string;
  kind: Quirk['kind'];
  before: number | null;
  after: number | null;
}
export interface QuirkOwnerChange {
  /** Mech variant, or `<set>/<component>` for a pod, or `<set> (n)` for a set bonus */
  owner: string;
  label: string;
  kind: 'mech' | 'pod' | 'set';
  changes: QuirkChange[];
}
export interface StatChange { key: string; before: string | null; after: string | null }
export interface ItemChange { name: string; label: string; kind: Item['kind']; changes: StatChange[] }
export interface DatasetDiff {
  from: string;
  to: string;
  mechsAdded: { variant: string; label: string }[];
  mechsRemoved: { variant: string; label: string }[];
  quirks: QuirkOwnerChange[];
  itemsAdded: { name: string; label: string; kind: Item['kind'] }[];
  itemsRemoved: { name: string; label: string; kind: Item['kind'] }[];
  items: ItemChange[];
}

/** Item values compared between versions; for weapons all raw WeaponStats attributes plus the ranges. */
function itemValues(i: Item): Record<string, string> {
  const out: Record<string, string> = { tons: String(i.tons), slots: String(i.slots), health: String(i.health) };
  if (i.kind === 'weapon') {
    const w = i as Weapon;
    for (const [k, v] of Object.entries(w.stats)) out[k] = v;
    out['ranges'] = w.ranges.map((r) => `${r.start}:${r.modifier}`).join(' ');
  } else if (i.kind === 'ammo') {
    out['shots'] = String(i.shots);
  } else if (i.kind === 'heatsink') {
    Object.assign(out, { cooling: String(i.cooling), engineCooling: String(i.engineCooling), heatbase: String(i.heatbase), engineHeatbase: String(i.engineHeatbase) });
  }
  return out;
}

function quirkDiff(before: Quirk[], after: Quirk[]): QuirkChange[] {
  const sum = (qs: Quirk[]) => {
    const m = new Map<string, Quirk & { total: number }>();
    for (const q of qs) {
      const prev = m.get(q.raw.toLowerCase());
      m.set(q.raw.toLowerCase(), { ...q, total: (prev?.total ?? 0) + q.value });
    }
    return m;
  };
  const a = sum(before);
  const b = sum(after);
  const out: QuirkChange[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    if (x && y && Math.abs(x.total - y.total) < 1e-9) continue;
    const q = (y ?? x)!;
    out.push({ raw: q.raw, label: q.label, kind: q.kind, before: x ? x.total : null, after: y ? y.total : null });
  }
  return out.sort((p, q) => p.label.localeCompare(q.label));
}

export function diffDatasets(old: Pick<Dataset, 'meta' | 'mechs' | 'chassis' | 'items'>, next: Pick<Dataset, 'meta' | 'mechs' | 'chassis' | 'items'>): DatasetDiff {
  const oldMechs = new Map(old.mechs.map((m) => [m.variant, m]));
  const newMechs = new Map(next.mechs.map((m) => [m.variant, m]));
  const quirks: QuirkOwnerChange[] = [];
  for (const [v, m] of newMechs) {
    const o = oldMechs.get(v);
    if (!o) continue;
    const changes = quirkDiff(o.quirks, m.quirks);
    if (changes.length) quirks.push({ owner: v, label: m.label, kind: 'mech', changes });
  }
  const pods = (d: Pick<Dataset, 'chassis'>) => {
    const out = new Map<string, { label: string; kind: 'pod' | 'set'; quirks: Quirk[] }>();
    for (const c of d.chassis) {
      for (const s of c.sets) {
        for (const [comp, p] of Object.entries(s.pods)) out.set(`${s.name}/${comp}`, { label: `${s.name.toUpperCase()} · ${comp}`, kind: 'pod', quirks: p.quirks });
        for (const b of s.bonuses) out.set(`${s.name} (${b.pieces})`, { label: `${s.name.toUpperCase()} · ${b.pieces}`, kind: 'set', quirks: b.quirks });
      }
    }
    return out;
  };
  const oldPods = pods(old);
  for (const [key, p] of pods(next)) {
    const o = oldPods.get(key);
    const changes = quirkDiff(o?.quirks ?? [], p.quirks);
    if (o && changes.length) quirks.push({ owner: key, label: p.label, kind: p.kind, changes });
  }

  const oldItems = new Map(old.items.map((i) => [i.name, i]));
  const newItems = new Map(next.items.map((i) => [i.name, i]));
  const items: ItemChange[] = [];
  for (const [name, i] of newItems) {
    const o = oldItems.get(name);
    if (!o) continue;
    const a = itemValues(o);
    const b = itemValues(i);
    const changes: StatChange[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[key] !== b[key]) changes.push({ key, before: a[key] ?? null, after: b[key] ?? null });
    }
    if (changes.length) items.push({ name, label: i.label, kind: i.kind, changes });
  }
  const brief = (m: { variant: string; label: string }) => ({ variant: m.variant, label: m.label });
  const briefItem = (i: Item) => ({ name: i.name, label: i.label, kind: i.kind });
  return {
    from: old.meta.buildVersion, to: next.meta.buildVersion,
    mechsAdded: [...newMechs.values()].filter((m) => !oldMechs.has(m.variant)).map(brief),
    mechsRemoved: [...oldMechs.values()].filter((m) => !newMechs.has(m.variant)).map(brief),
    quirks: quirks.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)),
    itemsAdded: [...newItems.values()].filter((i) => !oldItems.has(i.name)).map(briefItem),
    itemsRemoved: [...oldItems.values()].filter((i) => !newItems.has(i.name)).map(briefItem),
    items: items.sort((a, b) => a.label.localeCompare(b.label)),
  };
}
