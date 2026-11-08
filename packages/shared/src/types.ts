export type Faction = 'InnerSphere' | 'Clan';
export type HardpointType = 'ballistic' | 'energy' | 'missile' | 'ams';
export const HARDPOINT_TYPES: HardpointType[] = ['ballistic', 'energy', 'missile', 'ams'];

/** Components with their own slots; rear sides share slots and HP with the front. */
export const COMPONENTS = ['head', 'centre_torso', 'left_torso', 'right_torso', 'left_arm', 'right_arm', 'left_leg', 'right_leg'] as const;
export type ComponentName = (typeof COMPONENTS)[number];
export const REAR_OF: Partial<Record<ComponentName, string>> = {
  centre_torso: 'centre_torso_rear',
  left_torso: 'left_torso_rear',
  right_torso: 'right_torso_rear',
};

export type QuirkScope = 'weapon' | 'armor' | 'structure' | 'ammo' | 'mech';
export interface Quirk {
  /** Raw name from the game data */
  raw: string;
  key: string;
  value: number;
  kind: 'multiplier' | 'additive';
  scope: QuirkScope;
  /** Target in lower case, e.g. `isgaussrifle`, `ct`, `lrm`; null for mech-wide quirks */
  target: string | null;
  stat: string;
  label: string;
}

export interface Range { start: number; modifier: number }

export interface ItemBase {
  id: number;
  name: string;
  label: string;
  faction: Faction | 'Both';
  tons: number;
  slots: number;
  health: number;
  /** Allowed components; empty means all */
  components: string[];
  amountAllowed: number | null;
}
export interface Weapon extends ItemBase {
  kind: 'weapon';
  aliases: string[];
  weaponType: string;
  hardpoint: HardpointType;
  damage: number;
  heat: number;
  cooldown: number;
  duration: number;
  speed: number;
  numFiring: number;
  rof: number | null;
  ammoType: string | null;
  artemisCompatible: boolean;
  ranges: Range[];
  minRange: number;
  optimalRange: number;
  maxRange: number;
  /** All WeaponStats attributes, unchanged */
  stats: Record<string, string>;
}
export interface Ammo extends ItemBase { kind: 'ammo'; ammoType: string; shots: number; internalDamage: number }
export interface Engine extends ItemBase { kind: 'engine'; rating: number; heatsinks: number; sideSlots: number; engineType: string }
export interface HeatSink extends ItemBase { kind: 'heatsink'; cooling: number; engineCooling: number; heatbase: number; engineHeatbase: number }
export interface JumpJet extends ItemBase { kind: 'jumpjet'; minTons: number; maxTons: number }
export interface Masc extends ItemBase { kind: 'masc'; minTons: number; maxTons: number; boostSpeed: number }
export interface Equipment extends ItemBase { kind: 'ecm' | 'bap' | 'case' | 'tc' | 'internal' }
export type Item = Weapon | Ammo | Engine | HeatSink | JumpJet | Masc | Equipment;

export interface Upgrade {
  id: number;
  name: string;
  label: string;
  type: 'Armor' | 'Structure' | 'HeatSink' | 'Artemis';
  faction: Faction | 'Both';
  armorPerTon?: number;
  weightPerTon?: number;
  slots: number;
  fixedSlotItem?: number;
  fixedSlotsPerComponent?: number;
  componentsWithFixedSlots?: number;
  compatibleHeatSink?: number;
  extraSlots?: number;
  extraTons?: number;
}

export interface Hardpoint { id: number; type: HardpointType; count: number; rawType: number }
export interface InternalRef { id: number; toggleable: boolean }

export interface ComponentDef {
  name: string;
  slots: number;
  hp: number;
  internals: InternalRef[];
  fixed: number[];
  hardpoints: Hardpoint[];
  canEquipECM: boolean;
  omniSlot: boolean;
  /** Fixed pod (the centre torso on omnimechs) */
  podId: number | null;
}

export interface Movement {
  maxSpeedFactor: number;
  torsoYaw: number; torsoPitch: number; torsoYawSpeed: number; torsoPitchSpeed: number;
  armYaw: number; armPitch: number; armYawSpeed: number; armPitchSpeed: number;
  reverseMultiplier: number;
  archetype: string;
}

export type WeightClass = 'light' | 'medium' | 'heavy' | 'assault';
export const weightClassOf = (tons: number): WeightClass =>
  tons <= 35 ? 'light' : tons <= 55 ? 'medium' : tons <= 75 ? 'heavy' : 'assault';

export interface Mech {
  variant: string;
  id: number;
  chassis: string;
  label: string;
  faction: Faction;
  tons: number;
  weightClass: WeightClass;
  minEngine: number;
  maxEngine: number;
  maxJumpJets: number;
  canEquipECM: boolean;
  canEquipMASC: boolean;
  isOmni: boolean;
  variantType: string | null;
  /** Not for search and mech selection: special variants outside the normal rules (escort Atlas) and test mechs with `(T)` */
  special: boolean;
  /** Set of the fixed centre torso pod */
  ctSet: string | null;
  movement: Movement;
  components: ComponentDef[];
  quirks: Quirk[];
}

export interface Pod {
  id: number;
  /** Further IDs of the same pod: OmniPods.xml lists the right leg pod of smn-ml twice */
  aliasIds: number[];
  chassis: string;
  set: string;
  component: string;
  hardpoints: Hardpoint[];
  internals: InternalRef[];
  fixed: number[];
  canEquipECM: boolean;
  canEquipMASC: boolean;
  quirks: Quirk[];
}
export interface SetBonus { pieces: number; quirks: Quirk[] }
export interface PodSet { name: string; bonuses: SetBonus[]; pods: Record<string, Pod> }
export interface Chassis { name: string; sets: PodSet[] }

export interface LoadoutComponent {
  name: string;
  armor: number;
  podId: number | null;
  weapons: number[];
  ammo: number[];
  modules: number[];
  /** All items in file order; this is also their order in the game's build code */
  ordered: number[];
}
export interface Loadout {
  variant: string;
  mechId: number;
  name: string;
  armorType: number;
  structureType: number;
  heatSinkType: number;
  artemis: boolean;
  components: LoadoutComponent[];
  actuators: { left: string; right: string };
}

export interface SkillOverride { level: 'Faction' | 'WeightClass' | 'Tonnage' | 'Mech'; name: string; value: number; children: SkillOverride[] }
export interface SkillEffect {
  raw: string;
  quirk: Quirk;
  /** Base value; deviations are nested by faction → weight class → tonnage → mech */
  base: number;
  overrides: SkillOverride[];
}
export interface SkillNode {
  group: string;
  /** Name as in the game, e.g. "Kinetic Burst" */
  label: string;
  /** Category in the skill tree, e.g. "Firepower" */
  category: string;
  /** Column and row of the first node in the tree, for sorting */
  column: number;
  row: number;
  /** Requirements from the game data, e.g. jump jets or ECM */
  requires: { hardpoint?: string; equipment?: string }[];
  names: string[];
  effects: SkillEffect[];
}

export interface Meta {
  buildNumber: string;
  buildVersion: string;
  buildPlan: string;
  extractedAt: string;
  gameDir: string;
  counts: Record<string, number>;
  warnings: string[];
}

export interface Dataset {
  meta: Meta;
  items: Item[];
  upgrades: Upgrade[];
  mechs: Mech[];
  chassis: Chassis[];
  loadouts: Loadout[];
  skills: SkillNode[];
}
