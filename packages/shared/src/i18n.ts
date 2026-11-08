/** Languages and all texts that come from the game logic (rule messages, quirk sources, components). */
export type Locale = 'en' | 'de';
export const LOCALES: Locale[] = ['en', 'de'];

const en = {
  'issue.ecm-location': 'ECM is not allowed in {component}.',
  'issue.item-location': '{item} cannot go in {component}.',
  'issue.item-faction': '{item} does not match the mech’s faction.',
  'issue.hardpoints': '{component}: {used} {type} installed, but only {total} hardpoints.',
  'issue.slots': '{component}: {used} of {total} slots used.',
  'issue.slots-total': '{used} of {total} slots used (including {dynamic} for armor and structure).',
  'issue.armor': '{component}: {armor} armor, maximum {max}.',
  'issue.overweight': '{used} t, the limit is {max} t.',
  'issue.no-engine': 'No engine installed.',
  'issue.engine-rating': 'Engine {rating} is outside {min}–{max}.',
  'issue.engine-faction': '{item} does not match the mech’s faction.',
  'issue.jumpjets': '{count} jump jets, the limit is {max}.',
  'issue.jumpjet-class': '{item} does not fit {tons} t.',
  'issue.ecm-count': 'More than one ECM installed.',
  'issue.masc': 'This mech cannot carry MASC.',
  'issue.amount': '{item}: installed {count} times, the limit is {max}.',
  'issue.weapon-count': '{count} weapons installed, the limit is {max}.',
  'issue.skills': '{count} skill nodes active, the limit is {max}.',
  'note.ammo-unused': 'Ammo without a matching weapon: {ammo}',
  'note.weapon-no-ammo': 'Weapon without matching ammo: {ammo}',
  'note.unknown-dps': '{item}: DPS and heat/s cannot be calculated and are not counted.',
  'import.pod': 'Pod {id} does not fit {component} on this chassis and was ignored.',
  'import.item': 'Unknown item {id} in {component} was ignored.',
  'import.armor': 'Unknown armor type in the code, armor stays on stock.',
  'import.structure': 'Unknown structure type in the code, structure stays on stock.',
  'import.heatsink': 'Unknown heat sink type in the code, heat sinks stay on stock.',
  'code.invalid-char': 'Invalid character “{char}” in the build code.',
  'code.not-a-code': 'This does not look like a build code from the game.',
  'code.rear-incomplete': 'The rear armor in the build code is incomplete.',
  'code.armor-missing': 'The armor for {component} is missing from the build code.',
  'export.unknown-upgrade': 'Unknown armor or structure type.',
  'source.mech': 'Mech',
  'source.pod': 'Pod {set}',
  'source.pod-component': 'Pod {set} ({component})',
  'source.set': 'Set bonus {set} ({pieces} pieces)',
  'source.skill': 'Skill {name} ({count})',
  'comp.head': 'Head',
  'comp.centre_torso': 'CT',
  'comp.left_torso': 'LT',
  'comp.right_torso': 'RT',
  'comp.left_arm': 'LA',
  'comp.right_arm': 'RA',
  'comp.left_leg': 'LL',
  'comp.right_leg': 'RL',
  'comp.centre_torso_rear': 'CT rear',
  'comp.left_torso_rear': 'LT rear',
  'comp.right_torso_rear': 'RT rear',
};

export type MessageKey = keyof typeof en;

const de: Record<MessageKey, string> = {
  'issue.ecm-location': 'ECM ist in {component} nicht erlaubt.',
  'issue.item-location': '{item} darf nicht in {component}.',
  'issue.item-faction': '{item} passt nicht zur Fraktion des Mechs.',
  'issue.hardpoints': '{component}: {used} {type} eingebaut, aber nur {total} Hardpoints.',
  'issue.slots': '{component}: {used} von {total} Slots belegt.',
  'issue.slots-total': '{used} von {total} Slots belegt (inklusive {dynamic} für Panzerung und Struktur).',
  'issue.armor': '{component}: {armor} Panzerung, maximal {max}.',
  'issue.overweight': '{used} t, erlaubt sind {max} t.',
  'issue.no-engine': 'Keine Engine eingebaut.',
  'issue.engine-rating': 'Engine {rating} außerhalb von {min}–{max}.',
  'issue.engine-faction': '{item} passt nicht zur Fraktion des Mechs.',
  'issue.jumpjets': '{count} Jump Jets, erlaubt sind {max}.',
  'issue.jumpjet-class': '{item} passt nicht zu {tons} t.',
  'issue.ecm-count': 'Mehr als ein ECM eingebaut.',
  'issue.masc': 'Dieser Mech kann kein MASC tragen.',
  'issue.amount': '{item}: {count}-mal eingebaut, erlaubt {max}.',
  'issue.weapon-count': '{count} Waffen eingebaut, erlaubt sind {max}.',
  'issue.skills': '{count} Skill-Nodes aktiv, erlaubt sind {max}.',
  'note.ammo-unused': 'Munition ohne passende Waffe: {ammo}',
  'note.weapon-no-ammo': 'Waffe ohne passende Munition: {ammo}',
  'note.unknown-dps': '{item}: DPS und Hitze/s nicht berechenbar, zählt dort nicht mit.',
  'import.pod': 'Pod {id} passt nicht zu {component} dieses Chassis und wurde ignoriert.',
  'import.item': 'Unbekanntes Item {id} in {component} wurde ignoriert.',
  'import.armor': 'Unbekannter Panzerungstyp im Code, die Panzerung bleibt auf Stock.',
  'import.structure': 'Unbekannter Strukturtyp im Code, die Struktur bleibt auf Stock.',
  'import.heatsink': 'Unbekannter Heatsink-Typ im Code, die Heatsinks bleiben auf Stock.',
  'code.invalid-char': 'Ungültiges Zeichen „{char}“ im Build-Code.',
  'code.not-a-code': 'Das sieht nicht nach einem Build-Code aus dem Spiel aus.',
  'code.rear-incomplete': 'Die hintere Panzerung im Build-Code ist unvollständig.',
  'code.armor-missing': 'Die Panzerung für {component} fehlt im Build-Code.',
  'export.unknown-upgrade': 'Unbekannter Panzerungs- oder Strukturtyp.',
  'source.mech': 'Mech',
  'source.pod': 'Pod {set}',
  'source.pod-component': 'Pod {set} ({component})',
  'source.set': 'Set-Bonus {set} ({pieces} Teile)',
  'source.skill': 'Skill {name} ({count})',
  'comp.head': 'Kopf',
  'comp.centre_torso': 'CT',
  'comp.left_torso': 'LT',
  'comp.right_torso': 'RT',
  'comp.left_arm': 'LA',
  'comp.right_arm': 'RA',
  'comp.left_leg': 'LL',
  'comp.right_leg': 'RL',
  'comp.centre_torso_rear': 'CT hinten',
  'comp.left_torso_rear': 'LT hinten',
  'comp.right_torso_rear': 'RT hinten',
};

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, de };

type Params = Record<string, string | number>;
export interface Message { key: MessageKey; params?: Params }

export const formatNumber = (n: number, locale: Locale, maxDigits = 2) => new Intl.NumberFormat(locale, { maximumFractionDigits: maxDigits }).format(n);
/** With a fixed number of decimals, e.g. for tons */
export const formatFixed = (n: number, locale: Locale, digits: number) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

export function componentLabel(component: string, locale: Locale = 'en'): string {
  return MESSAGES[locale][`comp.${component}` as MessageKey] ?? component;
}

/** Fills placeholders. `{component}` is translated, numbers are formatted for the language. */
export function formatMessage(locale: Locale, key: MessageKey, params: Params = {}): string {
  return MESSAGES[locale][key].replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    if (name === 'component') return componentLabel(String(value), locale);
    return typeof value === 'number' ? formatNumber(value, locale) : value;
  });
}
export const formatMsg = (m: Message, locale: Locale) => formatMessage(locale, m.key, m.params);

type IssueKey = Extract<MessageKey, `issue.${string}`>;
export type IssueCode = IssueKey extends `issue.${infer C}` ? C : never;
export interface Issue { code: IssueCode; params?: Params; component?: string }
export const formatIssue = (i: Issue, locale: Locale) => formatMessage(locale, `issue.${i.code}` as MessageKey, i.params);

/** Where a quirk comes from. Kept as data instead of text so the display follows the language. */
export type QuirkSource =
  | { kind: 'mech' }
  | { kind: 'pod'; set: string; component?: string }
  | { kind: 'set'; set: string; pieces: number }
  | { kind: 'skill'; name: string; count: number };

export function formatSource(s: QuirkSource, locale: Locale): string {
  switch (s.kind) {
    case 'mech': return formatMessage(locale, 'source.mech');
    case 'pod': return s.component
      ? formatMessage(locale, 'source.pod-component', { set: s.set.toUpperCase(), component: s.component })
      : formatMessage(locale, 'source.pod', { set: s.set.toUpperCase() });
    case 'set': return formatMessage(locale, 'source.set', { set: s.set.toUpperCase(), pieces: s.pieces });
    case 'skill': return formatMessage(locale, 'source.skill', { name: s.name, count: s.count });
  }
}
