import { formatMessage, type Message, type MessageKey } from './i18n.ts';
import { resolveComponent, stockBuild, type Build, type GameIndex } from './rules.ts';
import type { Mech } from './types.ts';

/**
 * Build code of the in-game mechlab. The format is not documented but inferred from example codes
 * (see tests/buildcode.test.ts):
 *
 *   A 84 D < 0 J0 |Items   p B0 >J7 |Items   q …   w :0 :0 :0
 *   ^ ^^ ^ ^ ^ ^^          ^ ^^ ^^^                ^ CT, LT, RT rear
 *   │ │  │ │ │ CT armor    │ │  Pod (omnimechs only)
 *   │ │  │ │ Actuators     │ Armor
 *   │ │  │ Artemis + heat sinks
 *   │ │  Armor + structure
 *   │ Mech ID
 *   Version
 *
 * Numbers are base 64 with the lowest digit first, digit value = character code - 48.
 * The markers p–w and | lie above that range, so parsing is unambiguous.
 */
const SECTIONS: Record<string, string> = {
  p: 'right_torso', q: 'left_torso', r: 'left_arm', s: 'right_arm', t: 'left_leg', u: 'right_leg', v: 'head',
};
const REAR_MARKER = 'w';
const REAR_ORDER = ['centre_torso_rear', 'left_torso_rear', 'right_torso_rear'];
const VERSION = 'A';

/**
 * Position in the list = value in the code, in the order of UpgradeTypes.xml.
 * Confirmed by example codes: 2810, 2811, 2815 and 3100, 3101, 3102. The rest follow from the order.
 */
const ARMOR_TYPES = [2810, 2811, 2812, 2814, 2815, 2816];
const STRUCTURE_TYPES = [3100, 3101, 3102, 3103];
/**
 * Second header character: bit 0 Artemis, bits 1–2 heat sinks, bit 3 set for omnimechs.
 * Heat sinks confirmed by example codes, including both Clan types (AS7-D-H, a Clan battlemech).
 * The omni bit is inferred: Kit Fox and Ultraviolet have it, battlemechs do not.
 */
const HEAT_SINK_CODES = new Map([[3003, 0], [3002, 1], [3005, 2], [3006, 3]]);
const OMNI_BIT = 8;

/** State of an arm: both actuators, no hand, or none (also when the arm has no deselectable ones). */
export type ActuatorState = 0 | 1 | 2;
const ACTUATOR_BOTH: ActuatorState = 0;
const ACTUATOR_NO_HAND: ActuatorState = 1;
const ACTUATOR_NONE: ActuatorState = 2;
const ARMS = [['right_arm', 'right'], ['left_arm', 'left']] as const;

export class BuildCodeError extends Error {
  readonly detail: Message;
  constructor(key: MessageKey, params?: Message['params']) {
    super(formatMessage('en', key, params));
    this.detail = { key, params };
  }
}

const digit = (c: string) => c.charCodeAt(0) - 48;
const isDigit = (c: string) => digit(c) >= 0 && digit(c) < 64;
const encodeDigit = (n: number) => String.fromCharCode(48 + n);

export function decodeNumber(s: string): number {
  let value = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (!isDigit(s[i]!)) throw new BuildCodeError('code.invalid-char', { char: s[i]! });
    value = value * 64 + digit(s[i]!);
  }
  return value;
}

export function encodeNumber(n: number, minLength = 1): string {
  let out = '';
  let rest = n;
  do {
    out += encodeDigit(rest % 64);
    rest = Math.floor(rest / 64);
  } while (rest > 0);
  return out.padEnd(minLength, '0');
}

export interface DecodedBuild {
  version: string;
  mechId: number;
  /** null if the value in the code is unknown */
  armorType: number | null;
  structureType: number | null;
  heatSinkType: number | null;
  artemis: boolean;
  actuators: { left: ActuatorState; right: ActuatorState };
  armor: Record<string, number>;
  pods: Record<string, number>;
  items: Record<string, number[]>;
}

const splitItems = (s: string) => s.split('|').filter(Boolean).map(decodeNumber);

export function decodeBuildCode(input: string): DecodedBuild {
  const code = input.trim();
  const parts = code.split(/(?=[p-w])/);
  const first = parts.shift() ?? '';
  const pipe = first.indexOf('|');
  const head = pipe >= 0 ? first.slice(0, pipe) : first;
  if (head.length !== 8 || parts.length === 0) throw new BuildCodeError('code.not-a-code');

  const a = decodeNumber(head[3]!);
  const b = decodeNumber(head[4]!);
  const c = decodeNumber(head[5]!);
  const heatSink = b < OMNI_BIT * 2 ? [...HEAT_SINK_CODES].find(([, v]) => v === ((b >> 1) & 3)) : undefined;
  const decoded: DecodedBuild = {
    version: head[0]!,
    mechId: decodeNumber(head.slice(1, 3)),
    armorType: ARMOR_TYPES[a & 7] ?? null,
    structureType: STRUCTURE_TYPES[a >> 3] ?? null,
    heatSinkType: heatSink ? heatSink[0] : null,
    artemis: (b & 1) === 1,
    actuators: { right: (c & 3) as ActuatorState, left: ((c >> 2) & 3) as ActuatorState },
    armor: { centre_torso: decodeNumber(head.slice(6, 8)) },
    pods: {},
    items: { centre_torso: pipe >= 0 ? splitItems(first.slice(pipe)) : [] },
  };
  for (const part of parts) {
    const marker = part[0]!;
    const body = part.slice(1);
    if (marker === REAR_MARKER) {
      REAR_ORDER.forEach((name, i) => {
        const raw = body.slice(i * 2, i * 2 + 2);
        if (raw.length !== 2) throw new BuildCodeError('code.rear-incomplete');
        decoded.armor[name] = decodeNumber(raw);
      });
      continue;
    }
    const component = SECTIONS[marker]!;
    const pipeAt = body.indexOf('|');
    const fixedPart = pipeAt >= 0 ? body.slice(0, pipeAt) : body;
    if (fixedPart.length < 2) throw new BuildCodeError('code.armor-missing', { component });
    decoded.armor[component] = decodeNumber(fixedPart.slice(0, 2));
    if (fixedPart.length > 2) decoded.pods[component] = decodeNumber(fixedPart.slice(2));
    decoded.items[component] = pipeAt >= 0 ? splitItems(body.slice(pipeAt)) : [];
  }
  return decoded;
}

/** Deselectable actuators of an arm by kind. */
function armActuators(arm: string, build: Pick<Build, 'pods'>, mech: Pick<Mech, 'components'>, ix: GameIndex) {
  const def = mech.components.find((c) => c.name === arm);
  const toggleable = def ? resolveComponent(def, build, ix).internals.filter((r) => r.toggleable).map((r) => r.id) : [];
  const nameOf = (id: number) => ix.items.get(id)?.name;
  return {
    all: toggleable,
    lower: toggleable.find((id) => nameOf(id) === 'LowerArmActuator'),
    hand: toggleable.find((id) => nameOf(id) === 'HandActuator'),
  };
}

function actuatorStateOf(arm: string, build: Build, mech: Pick<Mech, 'components'>, ix: GameIndex): ActuatorState {
  const { lower, hand } = armActuators(arm, build, mech, ix);
  const removed = build.removedActuators[arm] ?? [];
  if (lower === undefined || removed.includes(lower)) return ACTUATOR_NONE;
  if (hand === undefined || removed.includes(hand)) return ACTUATOR_NO_HAND;
  return ACTUATOR_BOTH;
}

export interface ImportResult { build: Build; warnings: Message[] }

/** Applies a decoded code to the stock loadout. Unknown values stay stock and are reported. */
export function buildFromDecoded(decoded: DecodedBuild, mech: Pick<Mech, 'variant' | 'chassis' | 'components'>, ix: GameIndex): ImportResult {
  const warnings: Message[] = [];
  const build = stockBuild(mech.variant, ix);
  build.armor = { ...build.armor, ...decoded.armor };
  build.pods = { ...build.pods };
  for (const [component, id] of Object.entries(decoded.pods)) {
    const pod = ix.pods.get(id);
    if (pod && pod.chassis === mech.chassis && pod.component === component) build.pods[component] = id;
    else warnings.push({ key: 'import.pod', params: { id: String(id), component } });
  }
  const fixedEngine = build.engineId === null;
  build.items = {};
  for (const [component, ids] of Object.entries(decoded.items)) {
    const items: number[] = [];
    for (const id of ids) {
      const item = ix.items.get(id);
      if (!item) warnings.push({ key: 'import.item', params: { id: String(id), component } });
      else if (item.kind === 'engine' && !fixedEngine) build.engineId = id;
      else items.push(id);
    }
    build.items[component] = items;
  }
  if (decoded.armorType !== null) build.armorType = decoded.armorType;
  else warnings.push({ key: 'import.armor' });
  if (decoded.structureType !== null) build.structureType = decoded.structureType;
  else warnings.push({ key: 'import.structure' });
  if (decoded.heatSinkType !== null) build.heatSinkType = decoded.heatSinkType;
  else warnings.push({ key: 'import.heatsink' });
  build.artemis = decoded.artemis;

  build.removedActuators = {};
  for (const [arm, side] of ARMS) {
    const { all, hand } = armActuators(arm, build, mech, ix);
    const state = decoded.actuators[side];
    const removed = state === ACTUATOR_NONE ? all : state === ACTUATOR_NO_HAND && hand !== undefined ? [hand] : [];
    if (removed.length) build.removedActuators[arm] = removed;
  }
  return { build, warnings };
}

export type ExportResult = { code: string } | { code: null; reason: MessageKey };

export function encodeBuildCode(build: Build, mech: Pick<Mech, 'id' | 'components' | 'isOmni'>, ix: GameIndex): ExportResult {
  const armor = ARMOR_TYPES.indexOf(build.armorType);
  const structure = STRUCTURE_TYPES.indexOf(build.structureType);
  const heatSink = HEAT_SINK_CODES.get(build.heatSinkType);
  if (armor < 0 || structure < 0 || heatSink === undefined) return { code: null, reason: 'export.unknown-upgrade' };

  const header = encodeDigit(armor + structure * 8)
    + encodeDigit(+build.artemis + heatSink * 2 + (mech.isOmni ? OMNI_BIT : 0))
    + encodeDigit(actuatorStateOf('right_arm', build, mech, ix) + actuatorStateOf('left_arm', build, mech, ix) * 4);
  const items = (component: string) => {
    const ids = [...(build.items[component] ?? [])];
    if (component === 'centre_torso' && build.engineId !== null) ids.unshift(build.engineId);
    return ids.map((id) => `|${encodeNumber(id)}`).join('');
  };
  const fixedPods = new Set(mech.components.filter((c) => c.podId !== null).map((c) => c.name));
  let code = `${VERSION}${encodeNumber(mech.id, 2)}${header}${encodeNumber(build.armor['centre_torso'] ?? 0, 2)}${items('centre_torso')}`;
  for (const [marker, component] of Object.entries(SECTIONS)) {
    const pod = fixedPods.has(component) ? undefined : build.pods[component];
    code += `${marker}${encodeNumber(build.armor[component] ?? 0, 2)}${pod !== undefined ? encodeNumber(pod) : ''}${items(component)}`;
  }
  code += REAR_MARKER + REAR_ORDER.map((name) => encodeNumber(build.armor[name] ?? 0, 2)).join('');
  return { code };
}
