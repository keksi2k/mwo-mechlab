import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  humanQuirkLabel, parseQuirkName, weightClassOf,
  type Ammo, type Chassis, type ComponentDef, type Dataset, type Equipment, type Faction, type Hardpoint,
  type HardpointType, type InternalRef, type Item, type ItemBase, type Loadout, type Mech, type Pod, type PodSet,
  type Quirk, type SkillEffect, type SkillNode, type SkillOverride, type Upgrade, type Weapon,
} from '@mwo/shared';
import { Pak } from './pak.ts';
import { El, parseXml } from './xml.ts';

const HARDPOINT_BY_CODE: Record<number, HardpointType> = { 0: 'ballistic', 1: 'energy', 2: 'missile', 4: 'ams' };
const HARDPOINT_BY_WEAPON: Record<string, HardpointType> = { Ballistic: 'ballistic', Energy: 'energy', Missile: 'missile', AMS: 'ams' };

export async function extract(gameDir: string, log: (m: string) => void = () => {}): Promise<Dataset> {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  const build = parseXml(readFileSync(join(dirname(gameDir), 'build_info.xml'), 'utf8').replace(/^﻿/, ''));
  const buildText = (t: string) => build.one(t)?.text ?? '';

  log('Localization …');
  const locPak = await Pak.open(join(gameDir, 'Localized', 'English_xml.pak'));
  const loc = parseLocalization(await locPak.readText('Localization/English/TheRealLoc.xml'));
  locPak.close();
  const label = (tag: string | undefined, fallback: string) => {
    if (!tag) return fallback;
    return loc.get(tag.replace(/^@/, '').toLowerCase()) ?? fallback;
  };
  const makeQuirk = (raw: string, value: number): Quirk => {
    const parsed = parseQuirkName(raw);
    if (!parsed) {
      warn(`Quirk without a recognizable kind: ${raw}`);
      return { raw, key: raw.toLowerCase(), value, kind: 'additive', scope: 'mech', target: null, stat: raw.toLowerCase(), label: raw };
    }
    return { raw, ...parsed, value, label: loc.get(`ui_quirk_${parsed.key}`) ?? humanQuirkLabel(parsed) };
  };
  const quirksOf = (el: El) => el.all('Quirk').map((q) => makeQuirk(q.get('name')!, q.num('value')));

  log('GameData.pak …');
  const gd = await Pak.open(join(gameDir, 'GameData.pak'));
  const gdXml = async (n: string) => parseXml(await gd.readText(n));

  const items = await readItems(gdXml, label, warn);
  const itemIds = new Set(items.map((i) => i.id));
  const upgrades = readUpgrades(await gdXml('Libs/Items/UpgradeTypes/UpgradeTypes.xml'), label);
  const upgradeIds = new Set(upgrades.map((u) => u.id));
  const skills = readSkills(
    await gdXml('Libs/MechPilotTalents/MechSkillTreeNodes.xml'), await gdXml('Libs/MechPilotTalents/MechSkillTreeNodesDisplay.xml'), makeQuirk, loc, warn,
  );

  const mechList = [...(await gdXml('Libs/Items/Mechs/Mechs.xml')).walk('Mech')];
  const podIndex = new Map<number, { chassis: string; set: string; component: string }>();
  for (const p of (await gdXml('Libs/Items/OmniPods.xml')).walk('OmniPod')) {
    podIndex.set(p.num('id'), { chassis: p.get('chassis')!.toLowerCase(), set: p.get('set')!.toLowerCase(), component: p.get('component')! });
  }

  log('Mech paks …');
  const mdfs = new Map<string, El>();
  const hardpointSlots = new Map<string, Map<number, number>>();
  const omniFiles: { chassis: string; xml: El }[] = [];
  const mechDir = join(gameDir, 'mechs');
  let pakCount = 0;
  for (const f of readdirSync(mechDir).filter((n) => n.toLowerCase().endsWith('.pak')).sort()) {
    const pak = await Pak.open(join(mechDir, f));
    pakCount++;
    for (const name of pak.names()) {
      const lower = name.toLowerCase();
      const dir = lower.split('/').at(-2) ?? '';
      if (lower.endsWith('.mdf')) {
        mdfs.set(basename(lower, '.mdf'), parseXml(await pak.readText(name)));
      } else if (lower.endsWith('-hardpoints.xml')) {
        const map = new Map<number, number>();
        for (const h of parseXml(await pak.readText(name)).walk('Hardpoint')) map.set(h.num('id'), h.all('WeaponSlot').length);
        hardpointSlots.set(dir, map);
      } else if (lower.endsWith('-omnipods.xml')) {
        omniFiles.push({ chassis: dir, xml: parseXml(await pak.readText(name)) });
      }
    }
    pak.close();
  }

  const readHardpoints = (el: El, ch: string, ctx: string): Hardpoint[] =>
    el.all('Hardpoint').map((h) => {
      const rawType = h.num('Type');
      const type = HARDPOINT_BY_CODE[rawType];
      if (!type) warn(`Unknown hardpoint type ${rawType} in ${ctx}`);
      const id = h.num('ID');
      const count = hardpointSlots.get(ch)?.get(id);
      if (count === undefined) warn(`Hardpoint ${id} missing in ${ch}-hardpoints.xml (${ctx})`);
      return { id, type: type ?? 'energy', rawType, count: count ?? 1 };
    });
  const readInternals = (el: El): InternalRef[] =>
    el.all('Internal').map((i) => ({ id: i.num('ItemID'), toggleable: i.get('Toggleable') === '1' }));
  const readFixed = (el: El) => el.all('Fixed').map((f) => f.num('ItemID'));

  const chassis: Chassis[] = [];
  for (const { chassis: ch, xml } of omniFiles) {
    const sets: PodSet[] = [];
    const idsBySetComp = new Map<string, number[]>();
    for (const [id, p] of podIndex) {
      if (p.chassis !== ch) continue;
      const key = `${p.set}/${p.component}`;
      idsBySetComp.set(key, [...(idsBySetComp.get(key) ?? []), id]);
    }
    for (const s of xml.all('Set')) {
      const setName = s.get('name')!.toLowerCase();
      const pods: Record<string, Pod> = {};
      for (const c of s.all('component')) {
        const component = c.get('name')!;
        const [id, ...aliasIds] = idsBySetComp.get(`${setName}/${component}`) ?? [];
        if (id === undefined) {
          warn(`Pod without ID in OmniPods.xml: ${setName}/${component}`);
          continue;
        }
        pods[component] = {
          id, aliasIds, chassis: ch, set: setName, component,
          hardpoints: readHardpoints(c, ch, `${setName}/${component}`),
          internals: readInternals(c), fixed: readFixed(c),
          canEquipECM: c.get('CanEquipECM') === '1', canEquipMASC: c.get('CanEquipMASC') === '1',
          quirks: quirksOf(c),
        };
      }
      const bonuses = [...s.walk('Bonus')].map((b) => ({ pieces: b.num('PieceCount'), quirks: quirksOf(b) }));
      sets.push({ name: setName, bonuses, pods });
    }
    chassis.push({ name: ch, sets });
  }

  log('Mechs and loadouts …');
  const mechs: Mech[] = [];
  const loadoutFiles = new Map(gd.names().filter((n) => /^libs\/mechloadout\/.+\.xml$/i.test(n)).map((n) => [basename(n).slice(0, -4).toLowerCase(), n]));
  const loadouts: Loadout[] = [];
  for (const m of mechList) {
    const variant = m.get('name')!.toLowerCase();
    const mdf = mdfs.get(variant);
    if (!mdf) {
      warn(`No .mdf for ${variant}`);
      continue;
    }
    const ch = m.get('chassis')!.toLowerCase();
    const def = mdf.one('Mech')!;
    const tuning = mdf.one('MovementTuningConfiguration');
    const components: ComponentDef[] = [...mdf.walk('Component')].map((c) => ({
      name: c.get('Name')!,
      slots: c.num('Slots'),
      hp: c.num('HP'),
      internals: readInternals(c),
      fixed: readFixed(c),
      hardpoints: readHardpoints(c, ch, variant),
      canEquipECM: c.get('CanEquipECM') === '1',
      omniSlot: c.get('OmniSlot') === '1',
      podId: c.get('OmniPod') ? c.num('OmniPod') : null,
    }));
    const ctPod = components.find((c) => c.name === 'centre_torso')?.podId ?? null;
    const tons = def.num('MaxTons');
    const quirkList = mdf.one('QuirkList');
    mechs.push({
      variant, id: m.num('id'), chassis: ch,
      label: loc.get(variant) ?? variant.toUpperCase(),
      faction: m.get('faction') as Faction,
      tons, weightClass: weightClassOf(tons),
      minEngine: def.num('MinEngineRating'), maxEngine: def.num('MaxEngineRating'),
      maxJumpJets: def.num('MaxJumpJets'),
      canEquipECM: def.get('CanEquipECM') === '1' || components.some((c) => c.canEquipECM),
      canEquipMASC: def.get('CanEquipMASC') === '1',
      isOmni: components.some((c) => c.omniSlot),
      variantType: def.get('VariantType') ?? null,
      special: false,
      ctSet: ctPod !== null ? (podIndex.get(ctPod)?.set ?? null) : null,
      movement: {
        maxSpeedFactor: tuning?.num('MaxMovementSpeed') ?? 0,
        torsoYaw: tuning?.num('MaxTorsoAngleYaw') ?? 0,
        torsoPitch: tuning?.num('MaxTorsoAnglePitch') ?? 0,
        torsoYawSpeed: tuning?.num('TorsoTurnSpeedYaw') ?? 0,
        torsoPitchSpeed: tuning?.num('TorsoTurnSpeedPitch') ?? 0,
        armYaw: tuning?.num('MaxArmRotationYaw') ?? 0,
        armPitch: tuning?.num('MaxArmRotationPitch') ?? 0,
        armYawSpeed: tuning?.num('ArmTurnSpeedYaw') ?? 0,
        armPitchSpeed: tuning?.num('ArmTurnSpeedPitch') ?? 0,
        reverseMultiplier: tuning?.num('ReverseSpeedMultiplier') ?? 0,
        archetype: tuning?.get('MovementArchetype') ?? '',
      },
      components,
      quirks: quirkList ? quirksOf(quirkList) : [],
    });

    const lo = loadoutFiles.get(variant);
    if (!lo) {
      warn(`No stock loadout for ${variant}`);
      continue;
    }
    loadouts.push(readLoadout(variant, await gdXml(lo), itemIds, upgradeIds, podIndex, warn));
  }
  gd.close();

  addChassisNames(mechs, loc);

  // Special variants: stock armor outside the rules (e.g. escort Atlas)
  const byVariant = new Map(loadouts.map((l) => [l.variant, l]));
  for (const mech of mechs) {
    // Test mechs: `(T)` in the name, their quirks contain a whole skill package
    if (mech.label.endsWith('(T)')) mech.special = true;
    const head = byVariant.get(mech.variant)?.components.find((c) => c.name === 'head');
    if (head && head.armor > 18) {
      mech.special = true;
      warn(`Special variant ${mech.variant}: head armor ${head.armor}, hidden from search`);
    }
  }

  const distinctQuirks = new Set<string>();
  const collect = (qs: Quirk[]) => qs.forEach((q) => distinctQuirks.add(q.raw));
  mechs.forEach((m) => collect(m.quirks));
  for (const c of chassis) {
    for (const s of c.sets) {
      s.bonuses.forEach((b) => collect(b.quirks));
      Object.values(s.pods).forEach((p) => collect(p.quirks));
    }
  }

  return {
    meta: {
      buildNumber: buildText('BuildNumber'),
      buildVersion: buildText('BuildVersion'),
      buildPlan: buildText('BuildPlan'),
      extractedAt: new Date().toISOString(),
      gameDir,
      counts: {
        mechPaks: pakCount, mechs: mechs.length, loadouts: loadouts.length, omniChassis: chassis.length,
        weapons: items.filter((i) => i.kind === 'weapon').length, items: items.length,
        upgrades: upgrades.length, distinctQuirks: distinctQuirks.size, skillNodes: skills.length,
      },
      warnings,
    },
    items, upgrades, mechs, chassis, loadouts, skills,
  };
}

function parseLocalization(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of parseXml(xml).walk('Row')) {
    const cells = row.all('Cell');
    const keyIdx = cells.findIndex((c) => c.get('ss:Index') === '2');
    if (keyIdx < 0) continue;
    const key = cells[keyIdx]!.one('Data')?.text;
    const value = cells[keyIdx + 1]?.one('Data')?.text;
    if (key && value && !map.has(key.toLowerCase())) map.set(key.toLowerCase(), value);
  }
  return map;
}

const factionOf = (s: string | undefined): Faction | 'Both' => (!s || s.includes(',') ? 'Both' : (s as Faction));

type Lbl = (tag: string | undefined, fallback: string) => string;

const lettersOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Hero and some standard variants are called only "KOLOSS" or "BSK-3" in the game, so the chassis name
 * is put in front. The source is the game texts, otherwise the start of the other variant names; Clan chassis
 * without their own text are named after the game's pattern "ATLAS CLAN".
 */
function addChassisNames(mechs: Mech[], loc: Map<string, string>) {
  const fromLabels = new Map<string, string>();
  for (const m of mechs) {
    const prefix = m.label.split(' ').slice(0, -1).join(' ');
    if (!prefix || fromLabels.has(m.chassis)) continue;
    const letters = lettersOf(prefix);
    if (letters === m.chassis || (m.chassis.includes(letters) && !m.chassis.startsWith('clan') && !m.chassis.endsWith('clan'))) fromLabels.set(m.chassis, prefix);
  }
  const nameOf = (chassis: string): string => {
    const known = loc.get(chassis) ?? fromLabels.get(chassis);
    if (known) return known.toUpperCase();
    const base = chassis.replace(/^clan|clan$/, '');
    return base !== chassis ? `${nameOf(base)} CLAN` : chassis.toUpperCase();
  };
  for (const m of mechs) {
    const name = nameOf(m.chassis);
    // Already contains the name, possibly in another form: "GRAND DRAGON", "CLAN STALKER STK-3F-C"
    const base = lettersOf(name.replace(/ CLAN$/, ''));
    if (!lettersOf(m.label).includes(base)) m.label = `${name} ${m.label}`;
  }
}

function readWeapon(w: El, label: Lbl, warn: (m: string) => void): Weapon | null {
  const s = w.one('WeaponStats');
  if (!s) {
    warn(`Weapon without WeaponStats: ${w.get('name')}`);
    return null;
  }
  const weaponType = s.get('type') ?? '';
  const hardpoint = HARDPOINT_BY_WEAPON[weaponType];
  if (!hardpoint) {
    warn(`Unknown weapon type ${weaponType}: ${w.get('name')}`);
    return null;
  }
  const ranges = (w.one('Ranges')?.all('Range') ?? []).map((r) => ({ start: r.num('start'), modifier: r.num('damageModifier') }));
  const full = ranges.filter((r) => r.modifier >= 1);
  const positive = ranges.filter((r) => r.modifier > 0);
  return {
    kind: 'weapon', id: w.num('id'), name: w.get('name')!,
    label: label(w.one('Loc')?.get('nameTag'), w.get('name')!),
    faction: factionOf(w.get('faction')),
    tons: s.num('tons'), slots: s.num('slots'), health: s.num('Health'),
    components: [], amountAllowed: null,
    aliases: (w.get('HardpointAliases') ?? '').split(',').map((a) => a.trim()).filter(Boolean),
    weaponType, hardpoint,
    damage: s.num('damage'), heat: s.num('heat'), cooldown: s.num('cooldown'), duration: s.num('duration'),
    speed: s.num('speed'), numFiring: s.num('numFiring', 1),
    rof: s.get('rof') ? s.num('rof') : null,
    ammoType: s.get('ammoType') && s.get('ammoType') !== 'None' ? s.get('ammoType')! : null,
    artemisCompatible: s.get('useArtemisUpgradeBonus') === '1' || !!s.get('artemisAmmoType'),
    ranges,
    minRange: positive[0]?.start ?? 0,
    optimalRange: full.at(-1)?.start ?? 0,
    maxRange: ranges.at(-1)?.start ?? 0,
    stats: s.attrs,
  };
}

function moduleBase(m: El, ms: El | undefined, label: Lbl): ItemBase {
  const comps = ms?.get('components');
  return {
    id: m.num('id'), name: m.get('name')!,
    label: label(m.one('Loc')?.get('nameTag'), m.get('name')!),
    faction: factionOf(m.get('faction')),
    tons: ms?.num('tons') ?? 0, slots: ms?.num('slots') ?? 0, health: ms?.num('health') ?? 0,
    components: comps ? comps.split(',').map((c) => c.trim()) : [],
    amountAllowed: ms?.get('amountAllowed') ? ms.num('amountAllowed') : null,
  };
}

async function readItems(xml: (n: string) => Promise<El>, label: Lbl, warn: (m: string) => void): Promise<Item[]> {
  const items: Item[] = [];
  for (const w of (await xml('Libs/Items/Weapons/Weapons.xml')).walk('Weapon')) {
    const weapon = readWeapon(w, label, warn);
    if (weapon) items.push(weapon);
  }
  for (const m of (await xml('Libs/Items/Modules/Ammo.xml')).children) {
    const a = m.one('AmmoTypeStats');
    items.push({
      ...moduleBase(m, m.one('ModuleStats'), label), kind: 'ammo',
      ammoType: a?.get('type') ?? '', shots: a?.num('numShots') ?? 0, internalDamage: a?.num('internalDamage') ?? 0,
    } satisfies Ammo);
  }
  for (const m of (await xml('Libs/Items/Modules/Engines.xml')).children) {
    const e = m.one('EngineStats')!;
    const typeMatch = /^Engine_(.+)_\d+$/.exec(m.get('name')!);
    items.push({
      id: m.num('id'), name: m.get('name')!,
      label: label(m.one('Loc')?.get('nameTag'), m.get('name')!),
      faction: factionOf(m.get('faction')), tons: e.num('weight'), slots: e.num('slots'), health: e.num('health'),
      components: [], amountAllowed: null, kind: 'engine',
      rating: e.num('rating'), heatsinks: e.num('heatsinks'), sideSlots: e.num('sideSlots'),
      engineType: typeMatch?.[1] ?? 'Std',
    });
  }
  const equipKinds: Record<string, Equipment['kind']> = {
    CGECMStats: 'ecm', CBAPStats: 'bap', CClanBAPStats: 'bap', CClanLightBAPStats: 'bap',
    CCASEStats: 'case', CTargetingComputerStats: 'tc',
  };
  for (const m of (await xml('Libs/Items/Modules/Equipment.xml')).children) {
    const base = moduleBase(m, m.one('ModuleStats'), label);
    const ctype = m.get('CType')!;
    const hs = m.one('HeatSinkStats');
    if (hs) {
      items.push({
        ...base, kind: 'heatsink', cooling: hs.num('cooling'), engineCooling: hs.num('engineCooling'),
        heatbase: hs.num('heatbase'), engineHeatbase: hs.num('engineHeatbase'),
      });
    } else if (equipKinds[ctype]) {
      items.push({ ...base, kind: equipKinds[ctype]! });
    } else {
      warn(`Unknown equipment ${ctype}: ${m.get('name')}`);
    }
  }
  for (const m of (await xml('Libs/Items/Modules/JumpJets.xml')).children) {
    const j = m.one('JumpJetStats');
    items.push({ ...moduleBase(m, m.one('ModuleStats'), label), kind: 'jumpjet', minTons: j?.num('minTons') ?? 0, maxTons: j?.num('maxTons') ?? 0 });
  }
  for (const m of (await xml('Libs/Items/Modules/MASC.xml')).children) {
    const ms = m.one('ModuleStats');
    items.push({
      ...moduleBase(m, ms, label), kind: 'masc',
      minTons: ms?.num('TonsMin') ?? 0, maxTons: ms?.num('TonsMax') ?? 0, boostSpeed: m.one('MASCStats')?.num('BoostSpeed') ?? 0,
    });
  }
  for (const m of (await xml('Libs/Items/Modules/Internals.xml')).children) {
    items.push({ ...moduleBase(m, m.one('ModuleStats'), label), kind: 'internal' });
  }
  return items;
}

function readUpgrades(xml: El, label: Lbl): Upgrade[] {
  return xml.all('UpgradeType').map((u) => {
    const a = u.one('ArmorTypeStats');
    const s = u.one('StructureTypeStats');
    const su = u.one('SlotUsage');
    const h = u.one('HeatSinkTypeStats');
    const art = u.one('ArtemisTypeStats');
    return {
      id: u.num('id'), name: u.get('name')!,
      label: label(u.one('Loc')?.get('nameTag'), u.get('name')!),
      type: u.get('CType') as Upgrade['type'],
      faction: factionOf(u.get('faction')),
      armorPerTon: a?.num('armorPerTon'),
      weightPerTon: s?.num('weightPerTon'),
      slots: su?.num('slots') ?? 0,
      fixedSlotItem: su?.get('fixedSlotItem') ? su.num('fixedSlotItem') : undefined,
      fixedSlotsPerComponent: su?.get('fixedSlotsPerComponent') ? su.num('fixedSlotsPerComponent') : undefined,
      componentsWithFixedSlots: su?.get('componentsWithFixedSlots') ? su.num('componentsWithFixedSlots') : undefined,
      compatibleHeatSink: h?.num('compatibleHeatSink'),
      extraSlots: art?.num('extraSlots'),
      extraTons: art?.num('extraTons'),
    };
  });
}

function readLoadout(
  variant: string, xml: El, itemIds: Set<number>, upgradeIds: Set<number>,
  podIndex: Map<number, unknown>, warn: (m: string) => void,
): Loadout {
  const up = xml.one('Upgrades');
  const check = (id: number, tag: string) => {
    if (!itemIds.has(id)) warn(`Loadout ${variant}: unknown ${tag} ID ${id}`);
    return itemIds.has(id);
  };
  const upId = (t: string) => {
    const id = up?.one(t)?.num('ItemID') ?? 0;
    if (!upgradeIds.has(id)) warn(`Loadout ${variant}: unknown upgrade ${t}=${id}`);
    return id;
  };
  const components = [...xml.walk('component')].map((c) => {
    const pod = c.get('OmniPod');
    const podId = pod && pod !== 'none' ? Number(pod) : null;
    if (podId !== null && !podIndex.has(podId)) warn(`Loadout ${variant}: unknown pod ${podId}`);
    return {
      name: c.get('Name')!, armor: c.num('Armor'), podId,
      weapons: c.all('Weapon').map((w) => w.num('ItemID')).filter((id) => check(id, 'weapon')),
      ammo: c.all('Ammo').map((w) => w.num('ItemID')).filter((id) => check(id, 'ammo')),
      modules: c.all('Module').map((w) => w.num('ItemID')).filter((id) => check(id, 'module')),
      ordered: c.children.filter((x) => ['Weapon', 'Ammo', 'Module'].includes(x.tag)).map((x) => x.num('ItemID')).filter((id) => itemIds.has(id)),
    };
  });
  const act = xml.one('ActuatorState');
  return {
    variant, mechId: xml.num('MechID'), name: xml.get('Name') ?? variant,
    armorType: upId('Armor'), structureType: upId('Structure'), heatSinkType: upId('HeatSinks'),
    artemis: up?.one('Artemis')?.get('Equipped') === '1',
    components,
    actuators: { left: act?.get('LeftActuatorState') ?? '', right: act?.get('RightActuatorState') ?? '' },
  };
}

/**
 * The data does not assign nodes to a category directly. The columns do form contiguous blocks,
 * separated by empty columns, in the order of the category list.
 */
function skillCategoryBlocks(display: El, warn: (m: string) => void): { end: number; category: string }[] {
  const categories = display.all('Category').map((c) => c.get('name')!);
  const columns = [...new Set(display.all('Node').map((n) => n.num('column')))].sort((a, b) => a - b);
  const ends = columns.filter((c, i) => i === columns.length - 1 || columns[i + 1]! - c > 1);
  // Empty columns also separate skills within a category, so the start columns are fixed here.
  // The warnings below report it if a patch rearranges the tree.
  const STARTS = [0, 18, 30, 41, 47, 56, 65];
  if (categories.length !== STARTS.length) warn(`Skill tree: ${categories.length} categories instead of ${STARTS.length}, check the mapping`);
  for (const s of STARTS.slice(1)) if (!ends.includes(s - 2)) warn(`Skill tree: column ${s} no longer starts a block, check the mapping`);
  return STARTS.map((start, i) => ({ end: (STARTS[i + 1] ?? Infinity) - 1, category: categories[i] ?? `Kategorie ${start}` }));
}

function readSkills(
  xml: El, display: El, makeQuirk: (raw: string, value: number) => Quirk, loc: Map<string, string>, warn: (m: string) => void,
): SkillNode[] {
  const LEVELS = ['Faction', 'WeightClass', 'Tonnage', 'Mech'] as const;
  const positions = new Map(display.all('Node').map((n) => [n.get('name')!, { column: n.num('column'), row: n.num('row') }]));
  const blocks = skillCategoryBlocks(display, warn);
  const categoryLabel = (c: string) => loc.get(`emechtreecategory_${c.toLowerCase()}`) ?? c;
  const nodeLabel = (first: string, group: string) =>
    (loc.get(`emechtreenode_${first.toLowerCase()}`) ?? group.replace(/([a-z])([A-Z])/g, '$1 $2')).replace(/\s+\d+$/, '');
  const overridesOf = (el: El): SkillOverride[] =>
    el.children.filter((c) => (LEVELS as readonly string[]).includes(c.tag)).map((c) => ({
      level: c.tag as SkillOverride['level'], name: c.get('name')!, value: c.num('value'), children: overridesOf(c),
    }));
  return xml.all('Node').map((n) => {
    const names = n.get('names')!.split(',').map((s) => s.trim());
    const effects: SkillEffect[] = n.all('Effect').map((e) => ({
      raw: e.get('name')!, quirk: makeQuirk(e.get('name')!, e.num('value')), base: e.num('value'), overrides: overridesOf(e),
    }));
    const group = names[0]!.replace(/\d+$/, '');
    const placed = names.map((name) => positions.get(name));
    if (placed.some((p) => !p)) warn(`Skill ${group}: node without a position in the tree`);
    const column = Math.min(...placed.map((p) => p?.column ?? Infinity));
    const row = Math.min(...placed.map((p) => p?.row ?? Infinity));
    return {
      group, names, effects, column, row,
      label: nodeLabel(names[0]!, group),
      category: categoryLabel(blocks.find((b) => column <= b.end)!.category),
      requires: n.all('Require').map((r) => ({ hardpoint: r.get('hardpoint'), equipment: r.get('equipment') })),
    };
  }).sort((a, b) => a.column - b.column || a.row - b.row);
}
