import { formatNumber, type Locale } from './i18n.ts';
import type { Faction, Quirk, QuirkScope, Weapon } from './types.ts';

const WEAPON_STATS = new Set([
  'cooldown', 'heat', 'range', 'velocity', 'duration', 'rof', 'spread', 'jamchance', 'jamduration',
  'jamrampdownduration', 'minheatpenaltylevel', 'damage', 'critdamage', 'narcduration',
]);
const PREFIX_SCOPES: Record<string, QuirkScope> = { armorresist: 'armor', internalresist: 'structure', ammocapacity: 'ammo' };
/** Look like weapon targets but affect the mech. */
const MECH_TARGETS = new Set(['jumpjets']);

/**
 * Splits a quirk name. Forms in the game data:
 *  <target>_<stat>_<kind>   isgaussrifle_cooldown_multiplier
 *  <stat>_<target>_<kind>   armorresist_ct_additive, ammocapacity_clrm_artemis_additive
 *  <stat>_<kind>            heatdissipation_multiplier, torso_yawspeed_multiplier
 * Returns null if the kind is missing; anything else is at least a mech quirk.
 */
export function parseQuirkName(raw: string): Pick<Quirk, 'key' | 'kind' | 'scope' | 'target' | 'stat'> | null {
  const key = raw.toLowerCase();
  const m = /^(.+)_(multiplier|additive)$/.exec(key);
  if (!m) return null;
  const body = m[1]!;
  const kind = m[2] as Quirk['kind'];
  const first = body.indexOf('_');
  if (first > 0) {
    const prefix = body.slice(0, first);
    const scope = PREFIX_SCOPES[prefix];
    if (scope) return { key, kind, scope, target: body.slice(first + 1), stat: prefix };
  }
  const last = body.lastIndexOf('_');
  if (last > 0 && WEAPON_STATS.has(body.slice(last + 1)) && !MECH_TARGETS.has(body.slice(0, last))) {
    return { key, kind, scope: 'weapon', target: body.slice(0, last), stat: body.slice(last + 1) };
  }
  return { key, kind, scope: 'mech', target: null, stat: body };
}

const STAT_LABELS: Record<string, Record<Locale, string>> = {
  cooldown: { de: 'Cooldown', en: 'Cooldown' }, heat: { de: 'Hitze', en: 'Heat' }, range: { de: 'Reichweite', en: 'Range' },
  velocity: { de: 'Projektilgeschwindigkeit', en: 'Velocity' }, duration: { de: 'Strahldauer', en: 'Duration' }, rof: { de: 'Feuerrate', en: 'Rate of fire' },
  spread: { de: 'Streuung', en: 'Spread' }, jamchance: { de: 'Klemmchance', en: 'Jam chance' }, jamduration: { de: 'Klemmdauer', en: 'Jam duration' },
  jamrampdownduration: { de: 'Abklingen nach Klemmen', en: 'Jam ramp-down' }, rampdownduration: { de: 'Abklingzeit', en: 'Ramp-down' },
  minheatpenaltylevel: { de: 'Ghost-Heat-Schwelle', en: 'Ghost heat threshold' }, damage: { de: 'Schaden', en: 'Damage' },
  critdamage: { de: 'Kritischer Schaden', en: 'Critical damage' }, narcduration: { de: 'NARC-Dauer', en: 'NARC duration' },
  armorresist: { de: 'Panzerung', en: 'Armor' }, internalresist: { de: 'Struktur', en: 'Structure' }, ammocapacity: { de: 'Munition', en: 'Ammo' },
  heatdissipation: { de: 'Kühlung', en: 'Heat dissipation' }, maxheat: { de: 'Hitzekapazität', en: 'Heat capacity' },
  mechtopspeed: { de: 'Höchstgeschwindigkeit', en: 'Top speed' }, overheatdamage: { de: 'Überhitzungsschaden', en: 'Overheat damage' },
  externalheat: { de: 'Externe Hitze', en: 'External heat' }, critchance_receiving: { de: 'Erhaltene Kritchance', en: 'Critical hit chance received' },
  turnrate: { de: 'Drehrate', en: 'Turn rate' }, hillclimb: { de: 'Steigfähigkeit', en: 'Hill climb' },
  reversespeed: { de: 'Rückwärtsgeschwindigkeit', en: 'Reverse speed' }, sensorrange: { de: 'Sensorreichweite', en: 'Sensor range' },
  seismicsensorrange: { de: 'Seismik-Reichweite', en: 'Seismic sensor range' }, mechacceleration: { de: 'Beschleunigung', en: 'Acceleration' },
  mechdeceleration: { de: 'Abbremsen', en: 'Deceleration' }, accellerp_all: { de: 'Beschleunigung', en: 'Acceleration' },
  decellerp_all: { de: 'Abbremsen', en: 'Deceleration' }, turnlerp_all: { de: 'Drehrate', en: 'Turn rate' },
  torso_yawangle: { de: 'Torso-Drehwinkel', en: 'Torso twist angle' }, torso_yawspeed: { de: 'Torso-Drehrate', en: 'Torso twist rate' },
  torso_pitchangle: { de: 'Torso-Neigung', en: 'Torso pitch angle' }, torso_pitchspeed: { de: 'Torso-Neigungsrate', en: 'Torso pitch rate' },
  jumpjetslots: { de: 'Jump-Jet-Plätze', en: 'Jump jet slots' }, jumpjets_heat: { de: 'Jump-Jet-Hitze', en: 'Jump jet heat' },
  jumpjets_burntime: { de: 'Jump-Jet-Brenndauer', en: 'Jump jet burn time' }, jumpjets_initialthrust: { de: 'Jump-Jet-Schub', en: 'Jump jet thrust' },
  falldamage: { de: 'Fallschaden', en: 'Fall damage' }, screenshake: { de: 'Bildschirmwackeln', en: 'Screen shake' }, xpbonus: { de: 'XP-Bonus', en: 'XP bonus' },
  increasedarmor: { de: 'Panzerung gesamt', en: 'Total armor' }, increasedstructure: { de: 'Struktur gesamt', en: 'Total structure' },
};
const TARGET_LABELS: Record<string, Record<Locale, string>> = {
  all: { de: 'Alle Waffen', en: 'All weapons' }, hd: { de: 'Kopf', en: 'Head' }, ct: { de: 'CT', en: 'CT' }, lt: { de: 'LT', en: 'LT' }, rt: { de: 'RT', en: 'RT' },
  la: { de: 'LA', en: 'LA' }, ra: { de: 'RA', en: 'RA' }, ll: { de: 'LL', en: 'LL' }, rl: { de: 'RL', en: 'RL' },
  ctr: { de: 'CT hinten', en: 'CT rear' }, ltr: { de: 'LT hinten', en: 'LT rear' }, rtr: { de: 'RT hinten', en: 'RT rear' },
};
const TARGET_WORDS: [string, string][] = [
  ['antimissilesystem', 'AMS'], ['autocannon', 'AC'], ['machinegun', 'MG'], ['rocketlauncher', 'Rocket Launcher'], ['gaussrifle', 'Gauss'],
  ['narcbeacon', 'NARC'], ['nonpulse', 'Non-Pulse'], ['standard', 'Standard'], ['snubnose', 'Snub-Nose'], ['family', 'Family'], ['ballistic', 'Ballistic'],
  ['missile', 'Missile'], ['energy', 'Energy'], ['flamer', 'Flamer'], ['streak', 'Streak'], ['rotary', 'Rotary'], ['medium', 'Medium'], ['heavy', 'Heavy'],
  ['ultra', 'Ultra'], ['large', 'Large'], ['small', 'Small'], ['light', 'Light'], ['pulse', 'Pulse'], ['laser', 'Laser'], ['clan', 'Clan'], ['gauss', 'Gauss'],
  ['lbx', 'LB-X'], ['ppc', 'PPC'], ['srm', 'SRM'], ['lrm', 'LRM'], ['mrm', 'MRM'], ['atm', 'ATM'], ['tag', 'TAG'], ['std', 'Std'], ['lsr', 'Laser'], ['er', 'ER'], ['is', 'IS'], ['ac', 'AC'],
];

function targetLabel(target: string, locale: Locale): string {
  const known = TARGET_LABELS[target];
  if (known) return known[locale];
  const parts: string[] = [];
  let rest = target;
  while (rest.length > 0) {
    const digits = /^[\d_]+/.exec(rest);
    if (digits) {
      const n = digits[0].replace(/_/g, '');
      if (n && parts.length) parts[parts.length - 1] += `/${n}`;
      rest = rest.slice(digits[0].length);
      continue;
    }
    const word = TARGET_WORDS.find(([w]) => rest.startsWith(w));
    if (!word) return target.toUpperCase();
    parts.push(word[0] === 'family' && locale === 'de' ? 'Familie' : word[1]);
    rest = rest.slice(word[0].length);
  }
  return parts.join(' ');
}

export const statLabel = (stat: string, locale: Locale) => STAT_LABELS[stat]?.[locale] ?? stat;

/** Readable label built from the parts of the quirk name. */
export function humanQuirkLabel(p: Pick<Quirk, 'scope' | 'target' | 'stat' | 'key'>, locale: Locale = 'en'): string {
  const stat = STAT_LABELS[p.stat]?.[locale];
  if (p.scope === 'mech') return stat ?? p.key.replace(/_(multiplier|additive)$/, '').replace(/_/g, ' ');
  const target = p.target ? targetLabel(p.target, locale) : '';
  return `${target}: ${stat ?? p.stat}`;
}

/**
 * Label in the requested language. English uses the game's text if there is one
 * (`label`); German is assembled, because the game only ships English texts.
 */
export function quirkLabel(q: Pick<Quirk, 'scope' | 'target' | 'stat' | 'key' | 'label'>, locale: Locale): string {
  if (locale === 'en') return q.label;
  if (q.scope === 'mech' && !STAT_LABELS[q.stat]) return q.label;
  return humanQuirkLabel(q, locale);
}

/** Target that applies to all weapons. Whether this also holds for AMS is unverified, so AMS is left out. */
export const GLOBAL_TARGET = 'all';

/** Does the quirk apply to this weapon? Based on the HardpointAliases from the game data. */
export function quirkAppliesToWeapon(q: Pick<Quirk, 'scope' | 'target'>, w: Weapon, includeGlobal = false): boolean {
  if (q.scope !== 'weapon' || !q.target) return false;
  if (q.target === GLOBAL_TARGET) return includeGlobal && w.hardpoint !== 'ams';
  return w.name.toLowerCase() === q.target || w.aliases.some((a) => a.toLowerCase() === q.target);
}

export const factionMatches = (itemFaction: Faction | 'Both', mech: Faction) => itemFaction === 'Both' || itemFaction === mech;

/** Stats where lower values are better. */
const LOWER_IS_BETTER = new Set([
  'cooldown', 'heat', 'duration', 'spread', 'jamchance', 'jamduration', 'jamrampdownduration',
  'overheatdamage', 'externalheat', 'falldamage', 'screenshake', 'startupduration', 'critchance_receiving',
  'coolshotcooldown', 'stealtharmorcooldown', 'targetdecayduration',
]);
export const lowerIsBetter = (stat: string) => LOWER_IS_BETTER.has(stat);

export function formatQuirkValue(q: Pick<Quirk, 'kind' | 'value'>, locale: Locale = 'en'): string {
  const sign = q.value > 0 ? '+' : '';
  return q.kind === 'multiplier' ? `${sign}${formatNumber(q.value * 100, locale)}%` : `${sign}${formatNumber(q.value, locale)}`;
}
