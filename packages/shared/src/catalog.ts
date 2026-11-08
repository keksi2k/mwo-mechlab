import type { Locale } from './i18n.ts';
import type { Criterion, SearchFilters } from './search.ts';
import type { Dataset, Faction, HardpointType, Quirk, Weapon } from './types.ts';

export interface QuirkCatalogEntry {
  key: string;
  label: string;
  scope: Quirk['scope'];
  target: string | null;
  stat: string;
  kind: Quirk['kind'];
  /** Number of mechs or pods that carry the quirk */
  count: number;
}

export function quirkCatalog(d: Pick<Dataset, 'mechs' | 'chassis'>): QuirkCatalogEntry[] {
  const map = new Map<string, QuirkCatalogEntry>();
  const add = (q: Quirk) => {
    const e = map.get(q.key);
    if (e) e.count++;
    else map.set(q.key, { key: q.key, label: q.label, scope: q.scope, target: q.target, stat: q.stat, kind: q.kind, count: 1 });
  };
  d.mechs.forEach((m) => m.quirks.forEach(add));
  for (const c of d.chassis) {
    for (const s of c.sets) {
      s.bonuses.forEach((b) => b.quirks.forEach(add));
      Object.values(s.pods).forEach((p) => p.quirks.forEach(add));
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Stats that can be searched for specifically through weapon quirks. */
export const WEAPON_QUIRK_STATS = ['cooldown', 'heat', 'range', 'velocity', 'duration', 'rof', 'damage', 'spread', 'jamchance', 'minheatpenaltylevel'];

/** The other faction's counterpart, if the game data has one (`Foo` ↔ `ClanFoo`). */
export function weaponCounterparts(name: string, weapons: Pick<Weapon, 'name'>[]): string[] {
  const other = name.startsWith('Clan') ? name.slice(4) : `Clan${name}`;
  return weapons.some((w) => w.name === other) ? [name, other] : [name];
}

/** Not part of the normal selection: special weapons of single mechs and of missions. */
const SPECIAL_WEAPON = /^(Noble|Fake|DropShip)/;

export interface WeaponFamily { id: string; label: string; hardpoint: HardpointType; weapons: string[]; factions: (Faction | 'Both')[] }

/** Groups the IS and Clan versions of a weapon (`ERLargeLaser`, `ClanERLargeLaser`; Clan sometimes writes `Lsr`). */
export function weaponFamilies(weapons: Weapon[]): WeaponFamily[] {
  const map = new Map<string, Weapon[]>();
  for (const w of weapons) {
    if (SPECIAL_WEAPON.test(w.name)) continue;
    const id = w.name.replace(/^Clan/, '').replace(/Lsr$/, 'Laser').toLowerCase();
    map.set(id, [...(map.get(id) ?? []), w]);
  }
  return [...map].map(([id, members]) => {
    const sorted = [...members].sort((a, b) => Number(a.faction === 'Clan') - Number(b.faction === 'Clan'));
    return { id, label: sorted[0]!.label, hardpoint: sorted[0]!.hardpoint, weapons: sorted.map((w) => w.name), factions: sorted.map((w) => w.faction) };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

export interface SearchPreset { id: string; label: Record<Locale, string>; description: Record<Locale, string>; filters: SearchFilters; criteria: Criterion[] }

const AMS = ['AntiMissileSystem', 'ClanAntiMissileSystem'];

export const SEARCH_PRESETS: SearchPreset[] = [
  {
    id: 'ams',
    label: { de: 'Bestes AMS-Setup', en: 'Best AMS setup' },
    description: { de: 'Meiste AMS-Hardpoints, danach AMS-Schaden, Reichweite und Feuerrate. Omnimechs mit bester Pod-Auswahl.', en: 'Most AMS hardpoints, then AMS damage, range and rate of fire. Omnimechs with the best pods.' },
    filters: { minHardpoints: { ams: 1 } },
    criteria: [
      { kind: 'hardpoints', type: 'ams' },
      { kind: 'weaponQuirk', weapons: AMS, stat: 'damage' },
      { kind: 'weaponQuirk', weapons: AMS, stat: 'range' },
      { kind: 'weaponQuirk', weapons: AMS, stat: 'rof' },
    ],
  },
  {
    id: 'cooling',
    label: { de: 'Beste Kühlung', en: 'Best cooling' },
    description: { de: 'Höchster Quirk auf die Hitzeabgabe, danach Hitzekapazität.', en: 'Highest heat dissipation quirk, then heat capacity.' },
    filters: { requireQuirkMatch: true },
    criteria: [{ kind: 'quirk', key: 'heatdissipation_multiplier' }, { kind: 'quirk', key: 'maxheat_multiplier' }],
  },
  {
    id: 'laser',
    label: { de: 'Medium-Laser-Boot', en: 'Medium laser boat' },
    description: { de: 'Viele Energy-Hardpoints, dazu Reichweite und Hitze für den Medium Laser (Clan: ER Medium Laser).', en: 'Many energy hardpoints, plus range and heat for the medium laser (Clan: ER medium laser).' },
    filters: { minHardpoints: { energy: 6 } },
    criteria: [
      { kind: 'hardpoints', type: 'energy' },
      { kind: 'weaponQuirk', weapons: ['MediumLaser', 'ClanERMediumLaser'], stat: 'range', includeGlobal: true },
      { kind: 'weaponQuirk', weapons: ['MediumLaser', 'ClanERMediumLaser'], stat: 'heat', includeGlobal: true },
    ],
  },
  {
    id: 'speed',
    label: { de: 'Schnellste Mechs', en: 'Fastest mechs' },
    description: { de: 'Höchste Geschwindigkeit mit der größten Engine, ohne Skills.', en: 'Highest speed with the largest engine, without skills.' },
    filters: {},
    criteria: [{ kind: 'mech', field: 'maxSpeed' }],
  },
];
