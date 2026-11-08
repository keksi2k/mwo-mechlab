import { useEffect, useMemo, useState } from 'react';
import {
  analyze, ASSUMPTIONS, buildFromDecoded, BuildCodeError, buildIndex, componentLabel, COMPONENTS, decodeBuildCode, encodeBuildCode, factionMatches, formatIssue, formatQuirkValue, formatSource, quirkLabel,
  HARDPOINT_TYPES, REAR_OF, resolveSkillValue, setArtemis, skillAvailable, stockBuild, volleyDamage,
  type Analysis, type Build, type Message, type ComponentUsage, type Engine, type GameIndex, type HardpointType, type Item, type Mech, type SkillNode, type Upgrade,
} from '@mwo/shared';
import { api, type Catalog, type MechDetail } from './api.ts';
import { go, type Route } from './App.tsx';
import { fixed, getLocale, msg, msgKey, num, t, type UiKey } from './i18n.ts';

const LAYOUT: (typeof COMPONENTS)[number][] = ['left_arm', 'left_torso', 'centre_torso', 'right_torso', 'right_arm', 'left_leg', 'head', 'right_leg'];
const HP_SHORT: Record<HardpointType, string> = { ballistic: 'B', energy: 'E', missile: 'M', ams: 'AMS' };
const PICKER_TABS: { id: string; label: UiKey; kinds: Item['kind'][] }[] = [
  { id: 'weapon', label: 'lab.tab-weapons', kinds: ['weapon'] },
  { id: 'ammo', label: 'lab.tab-ammo', kinds: ['ammo'] },
  { id: 'equip', label: 'lab.tab-equipment', kinds: ['heatsink', 'jumpjet', 'ecm', 'bap', 'case', 'tc', 'masc'] },
];

export function buildCatalogIndex(catalog: Catalog, detail: MechDetail): GameIndex {
  return buildIndex({
    items: catalog.items, upgrades: catalog.upgrades, skills: catalog.skills,
    mechs: [detail.mech], chassis: detail.chassis ? [detail.chassis] : [], loadouts: [detail.loadout],
  });
}

function parsePods(params: URLSearchParams): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (params.get('pods') ?? '').split(',')) {
    const [c, id] = part.split(':');
    if (c && id && Number.isFinite(Number(id))) out[c] = Number(id);
  }
  return out;
}

/** Opens the mech from a build code in the mechlab. Returns an error message if that is not possible. */
function openBuildCode(code: string, catalog: Catalog): string | null {
  try {
    const decoded = decodeBuildCode(code);
    const mech = catalog.mechs.find((m) => m.id === decoded.mechId);
    if (!mech) return t('lab.mech-id-unknown', { id: String(decoded.mechId) });
    go(`#/mechlab/${mech.variant}?code=${encodeURIComponent(code.trim())}`);
    return null;
  } catch (e) {
    return e instanceof BuildCodeError ? msg(e.detail) : (e as Error).message;
  }
}

export function MechlabPage({ catalog, route }: { catalog: Catalog; route: Route }) {
  const [detail, setDetail] = useState<MechDetail | null>(null);
  const [build, setBuild] = useState<Build | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const [importWarnings, setImportWarnings] = useState<Message[]>([]);
  const buildId = route.params.get('build');
  const code = route.params.get('code');

  useEffect(() => {
    if (!route.variant) return;
    let cancelled = false;
    (async () => {
      const d = await api.mech(route.variant!);
      if (cancelled) return;
      const ix = buildCatalogIndex(catalog, d);
      let b = stockBuild(d.mech.variant, ix);
      b = { ...b, pods: { ...b.pods, ...parsePods(route.params) } };
      if (code) {
        const decoded = decodeBuildCode(code);
        if (decoded.mechId !== d.mech.id) throw new Error(t('lab.other-mech-code'));
        const imported = buildFromDecoded(decoded, d.mech, ix);
        b = imported.build;
        setImportWarnings(imported.warnings);
      }
      if (buildId) {
        const found = (await api.builds()).find((x) => x.id === buildId);
        if (found && found.variant === d.mech.variant) {
          b = found.build;
          setSaved({ id: found.id, name: found.name });
        }
      }
      if (cancelled) return;
      setDetail(d);
      setBuild(b);
    })().catch((e: Error) => !cancelled && setError(e instanceof BuildCodeError ? msg(e.detail) : e.message));
    return () => {
      cancelled = true;
    };
  }, [route.variant, route.params, buildId, code, catalog]);

  if (!route.variant) return <MechPicker catalog={catalog} />;
  if (error) return <div className="banner error">{error}</div>;
  if (!detail || !build) return <div className="empty">{t('lab.loading')}</div>;
  return <Lab catalog={catalog} detail={detail} build={build} setBuild={setBuild} saved={saved} setSaved={setSaved} importWarnings={importWarnings} />;
}

function CodeImport({ catalog }: { catalog: Catalog }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => setError(openBuildCode(text, catalog));
  return (
    <div className="code-import">
      <div className="code-row">
        <input value={text} placeholder={t('code.import-placeholder')} aria-label={t('code.field')} spellCheck={false}
          onChange={(e) => { setText(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <button disabled={!text.trim()} onClick={submit}>{t('code.import')}</button>
      </div>
      {error && <p className="bad small-text">{error}</p>}
    </div>
  );
}

function BuildCodePanel({ catalog, build, detail, ix }: { catalog: Catalog; build: Build; detail: MechDetail; ix: GameIndex }) {
  const result = useMemo(() => encodeBuildCode(build, detail.mech, ix), [build, detail, ix]);
  const [copied, setCopied] = useState(false);
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="panel build-code">
      <h3>{t('code.title')}</h3>
      {result.code !== null ? (
        <>
          <div className="code-row">
            <input readOnly value={result.code} aria-label={t('code.exported')} spellCheck={false} onFocus={(e) => e.target.select()} />
            <button onClick={() => void copy(result.code!)}>{copied ? t('code.copied') : t('code.copy')}</button>
          </div>
        </>
      ) : (
        <p className="muted">{t('code.not-possible', { reason: msgKey(result.reason) })}</p>
      )}
      <CodeImport catalog={catalog} />
    </section>
  );
}

function MechPicker({ catalog }: { catalog: Catalog }) {
  const [text, setText] = useState('');
  const list = useMemo(() => {
    const t = text.trim().toLowerCase();
    return catalog.mechs.filter((m) => !t || m.label.toLowerCase().includes(t) || m.variant.includes(t) || m.chassis.includes(t)).slice(0, 80);
  }, [text, catalog]);
  return (
    <div className="panel picker-page">
      <h2>{t('lab.pick-title')}</h2>
      <CodeImport catalog={catalog} />
      <input autoFocus value={text} placeholder={t('lab.pick-placeholder')} onChange={(e) => setText(e.target.value)} />
      <ul className="mech-list">
        {list.map((m) => <li key={m.variant}><a href={`#/mechlab/${m.variant}`}>{m.label}<span className="muted"> {m.tons} t · {m.faction === 'Clan' ? 'Clan' : 'IS'}</span></a></li>)}
        {list.length === 0 && <li className="muted">{t('lab.pick-empty')}</li>}
      </ul>
    </div>
  );
}

function Lab({ catalog, detail, build, setBuild, saved, setSaved, importWarnings }: {
  catalog: Catalog; detail: MechDetail; build: Build; setBuild: (b: Build) => void;
  saved: { id: string; name: string } | null; setSaved: (s: { id: string; name: string } | null) => void; importWarnings: Message[];
}) {
  const ix = useMemo(() => buildCatalogIndex(catalog, detail), [catalog, detail]);
  const a = useMemo(() => analyze(build, ix), [build, ix]);
  const [selected, setSelected] = useState<string>('right_arm');
  const [tab, setTab] = useState('weapon');
  const [text, setText] = useState('');
  const [name, setName] = useState(saved?.name ?? detail.mech.label);
  const [status, setStatus] = useState<string | null>(null);
  const mech = detail.mech;
  const usage = (c: string) => a.components.find((u) => u.name === c);

  const addItem = (item: Item) => setBuild({ ...build, items: { ...build.items, [selected]: [...(build.items[selected] ?? []), item.id] } });
  const removeItem = (comp: string, index: number) => {
    const next = [...(build.items[comp] ?? [])];
    next.splice(index, 1);
    setBuild({ ...build, items: { ...build.items, [comp]: next } });
  };
  const setPod = (comp: string, id: number) => setBuild({ ...build, pods: { ...build.pods, [comp]: id } });
  const setArmor = (comp: string, value: number) => setBuild({ ...build, armor: { ...build.armor, [comp]: Math.max(0, value) } });
  const toggleActuator = (comp: string, id: number) => {
    // As in the game: without a lower arm there is no hand, and the hand needs the lower arm.
    const cur = build.removedActuators[comp] ?? [];
    const toggles = usage(comp)?.internals.filter((i) => i.toggleable).map((i) => i.item) ?? [];
    const idOf = (name: string) => toggles.find((t) => t.name === name)?.id;
    const lower = idOf('LowerArmActuator');
    const hand = idOf('HandActuator');
    let next: number[];
    if (cur.includes(id)) next = cur.filter((x) => x !== id && !(id === hand && x === lower));
    else next = [...new Set([...cur, id, ...(id === lower && hand !== undefined ? [hand] : [])])];
    setBuild({ ...build, removedActuators: { ...build.removedActuators, [comp]: next } });
  };
  const stripWeapons = () => setBuild({ ...build, items: Object.fromEntries(Object.entries(build.items).map(([k]) => [k, []])) });
  const maxArmor = () => {
    const armor = { ...build.armor };
    for (const u of a.components) {
      const rear = REAR_OF[u.name as keyof typeof REAR_OF];
      if (rear) {
        armor[rear] = Math.round(u.armorMax * 0.25);
        armor[u.name] = u.armorMax - armor[rear]!;
      } else armor[u.name] = u.armorMax;
    }
    setBuild({ ...build, armor });
  };
  const resetStock = () => {
    setBuild(stockBuild(mech.variant, ix));
    setSaved(null);
    setStatus(null);
  };

  const save = async () => {
    try {
      if (saved) {
        const r = await api.updateBuild(saved.id, name, build);
        setSaved({ id: r.id, name: r.name });
        setStatus(t('lab.saved'));
      } else {
        const r = await api.createBuild(name, build);
        setSaved({ id: r.id, name: r.name });
        setStatus(t('lab.saved-new'));
      }
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  const pickable = useMemo(() => {
    const kinds = PICKER_TABS.find((d) => d.id === tab)!.kinds;
    const needle = text.trim().toLowerCase();
    const hs = ix.upgrades.get(build.heatSinkType)?.compatibleHeatSink;
    return catalog.items.filter((i) => {
      if (!kinds.includes(i.kind) || !factionMatches(i.faction, mech.faction)) return false;
      if (needle && !i.label.toLowerCase().includes(needle) && !i.name.toLowerCase().includes(needle)) return false;
      if (i.kind === 'heatsink' && i.id !== hs) return false;
      if (i.kind === 'jumpjet' && (mech.maxJumpJets <= 0 || mech.tons < i.minTons || mech.tons > i.maxTons)) return false;
      if (i.kind === 'masc' && (mech.tons < i.minTons || mech.tons > i.maxTons)) return false;
      return true;
    }).sort((x, y) => x.label.localeCompare(y.label));
  }, [catalog, tab, text, mech, build.heatSinkType, ix]);

  const sel = usage(selected);
  const tonsLeft = a.tonsMax - a.tonsUsed;

  return (
    <div className="lab">
      <div className="lab-head panel">
        <div>
          <h2>{mech.label}</h2>
          <div className="muted">
            {mech.tons} t · {mech.faction === 'Clan' ? 'Clan' : 'Inner Sphere'} · {mech.isOmni ? t('lab.omnimech') : t('lab.battlemech')}
            {mech.variantType && ` · ${mech.variantType}`}
          </div>
        </div>
        <div className="lab-actions">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('lab.build-name')} />
          <button className="primary" onClick={save}>{saved ? t('lab.save') : t('lab.save-new')}</button>
          <button onClick={resetStock}>{t('lab.stock')}</button>
          <button onClick={stripWeapons}>{t('lab.strip')}</button>
          <button onClick={maxArmor}>{t('lab.max-armor')}</button>
          <button onClick={() => go('#/mechlab')}>{t('lab.other-mech')}</button>
          {status && <span className="muted">{status}</span>}
        </div>
      </div>

      {a.issues.length > 0 && (
        <div className="banner error">
          <strong>{a.issues.length === 1 ? t('lab.problem-one') : t('lab.problem-many', { count: a.issues.length })}:</strong>
          <ul>{a.issues.map((i, k) => <li key={k}>{formatIssue(i, getLocale())}</li>)}</ul>
        </div>
      )}
      {importWarnings.length > 0 && <div className="banner note"><strong>{t('lab.on-import')}</strong><ul>{importWarnings.map((n, k) => <li key={k}>{msg(n)}</li>)}</ul></div>}
      {a.notes.length > 0 && <div className="banner note"><ul>{a.notes.map((n, k) => <li key={k}>{msg(n)}</li>)}</ul></div>}

      <div className="lab-grid">
        <div className="comp-grid">
          {LAYOUT.map((c) => {
            const u = usage(c);
            if (!u) return null;
            return (
              <ComponentCard key={c} u={u} selected={selected === c} detail={detail} build={build} onSelect={() => setSelected(c)}
                onRemove={(i) => removeItem(c, i)} onPod={(id) => setPod(c, id)} onArmor={setArmor} onActuator={(id) => toggleActuator(c, id)} />
            );
          })}
        </div>

        <aside className="lab-side">
          <Stats a={a} tonsLeft={tonsLeft} />
          <Loadout mech={detail} build={build} setBuild={setBuild} catalog={catalog} ix={ix} a={a} />
        </aside>

        <section className="panel picker">
          <h3>{t('lab.install-in', { component: componentLabel(selected, getLocale()) })} {sel && <span className="muted">· {t('lab.free', { slots: sel.slotsTotal - sel.slotsUsed, tons: fixed(tonsLeft, 2) })}</span>}</h3>
          <div className="tabs">
            {PICKER_TABS.map((tabDef) => <button key={tabDef.id} className={tab === tabDef.id ? 'on' : ''} onClick={() => setTab(tabDef.id)}>{t(tabDef.label)}</button>)}
            <input value={text} placeholder={t('lab.search')} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="pick-list">
            {pickable.map((i) => <PickItem key={i.id} item={i} sel={sel} tonsLeft={tonsLeft} weaponsFull={a.weaponCount >= ASSUMPTIONS.maxWeapons} onAdd={() => addItem(i)} />)}
            {pickable.length === 0 && <p className="muted">{t('lab.nothing')}</p>}
          </div>
        </section>

        <BuildCodePanel catalog={catalog} build={build} detail={detail} ix={ix} />
        <Weapons a={a} />
        <Quirks a={a} />
        <Skills catalog={catalog} build={build} setBuild={setBuild} a={a} ix={ix} mech={mech} />
      </div>
    </div>
  );
}

function PickItem({ item, sel, tonsLeft, weaponsFull, onAdd }: { item: Item; sel: ComponentUsage | undefined; tonsLeft: number; weaponsFull: boolean; onAdd: () => void }) {
  const fits = (() => {
    if (!sel) return false;
    if (item.slots > sel.slotsTotal - sel.slotsUsed || item.tons > tonsLeft + 1e-6) return false;
    if (item.kind === 'weapon') {
      if (weaponsFull) return false;
      const hp = sel.hardpoints[item.hardpoint];
      if (hp.used >= hp.total) return false;
    }
    if (item.components.length > 0 && !item.components.includes(sel.name)) return false;
    return true;
  })();
  return (
    <button className={`pick ${fits ? '' : 'nofit'}`} title={fits ? t('lab.install') : t('lab.nofit')} onClick={onAdd}>
      {item.kind === 'weapon' && <span className={`dot hp-${item.hardpoint}`} />}
      <span className="pick-name">{item.label}</span>
      <span className="muted pick-meta">
        {item.kind === 'weapon' && item.damage > 0 && `${num(volleyDamage(item, item.damage), 1)} ${t('lab.dmg-short')} · `}
        {num(item.tons)} t · {item.slots} S
      </span>
    </button>
  );
}

function ComponentCard({ u, selected, detail, build, onSelect, onRemove, onPod, onArmor, onActuator }: {
  u: ComponentUsage; selected: boolean; detail: MechDetail; build: Build; onSelect: () => void; onRemove: (i: number) => void;
  onPod: (id: number) => void; onArmor: (c: string, v: number) => void; onActuator: (id: number) => void;
}) {
  const def = detail.mech.components.find((c) => c.name === u.name);
  const swappable = !!def?.omniSlot && def.podId === null && !!detail.chassis;
  const rear = REAR_OF[u.name as keyof typeof REAR_OF];
  const overSlots = u.slotsUsed > u.slotsTotal;
  const front = build.armor[u.name] ?? 0;
  const back = rear ? (build.armor[rear] ?? 0) : 0;
  return (
    <div className={`comp comp-${u.name} ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="comp-title">
        <strong>{componentLabel(u.name, getLocale())}</strong>
        <span className={overSlots ? 'bad' : 'muted'}>{u.slotsUsed}/{u.slotsTotal}</span>
      </div>
      <div className="comp-hp">
        {HARDPOINT_TYPES.filter((type) => u.hardpoints[type].total > 0).map((type) => (
          <span key={type} className={`hp hp-${type} ${u.hardpoints[type].used > u.hardpoints[type].total ? 'over' : ''}`}>{u.hardpoints[type].used}/{u.hardpoints[type].total} {HP_SHORT[type]}</span>
        ))}
      </div>
      {swappable && (
        <select className="pod" value={u.pod?.id ?? ''} onClick={(e) => e.stopPropagation()} onChange={(e) => onPod(Number(e.target.value))}>
          {detail.chassis!.sets.map((s) => s.pods[u.name]).filter((p) => !!p).map((p) => <option key={p!.id} value={p!.id}>{p!.set.toUpperCase()}</option>)}
        </select>
      )}
      <div className="armor" onClick={(e) => e.stopPropagation()}>
        <label>{t('lab.armor')}<input type="number" min={0} max={u.armorMax} value={front} onChange={(e) => onArmor(u.name, Number(e.target.value))} /></label>
        {rear && <label>{t('lab.rear')}<input type="number" min={0} max={u.armorMax} value={back} onChange={(e) => onArmor(rear, Number(e.target.value))} /></label>}
        <span className={front + back > u.armorMax ? 'bad' : 'muted'}>{t('lab.max', { max: u.armorMax })}</span>
      </div>
      <ul className="slots">
        {u.items.map((i, k) => (
          <li key={k} className={`slot kind-${i.kind}`} title={t('lab.remove-item')} onClick={(e) => { e.stopPropagation(); onRemove(k); }}>
            {i.kind === 'weapon' && <span className={`dot hp-${i.hardpoint}`} />}{i.label}<span className="x">×</span>
          </li>
        ))}
        {u.fixedItems.filter((i) => i.kind !== 'engine').map((i, k) => <li key={`f${k}`} className="slot fixed" title={t('lab.fixed')}>{i.label}</li>)}
        {u.engineSlots > 0 && u.name === 'centre_torso' && <li className="slot fixed">{t('lab.engine')}</li>}
        {u.engineSlots > 0 && u.name !== 'centre_torso' && <li className="slot fixed">{t('lab.engine-side', { slots: u.engineSlots })}</li>}
        {u.internals.filter((i) => i.toggleable).map((i) => (
          <li key={i.item.id} className={`slot toggle ${i.removed ? 'off' : ''}`} title={t('lab.toggle-actuator')} onClick={(e) => { e.stopPropagation(); onActuator(i.item.id); }}>{i.item.label}</li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value, hint, bad }: { label: string; value: string; hint?: string; bad?: boolean }) {
  return <div className="stat" title={hint}><div className="stat-label">{label}</div><div className={`stat-value ${bad ? 'bad' : ''}`}>{value}</div></div>;
}

function Stats({ a, tonsLeft }: { a: Analysis; tonsLeft: number }) {
  return (
    <div className="panel stats">
      <Stat label={t('stat.weight')} value={`${fixed(a.tonsUsed, 2)} / ${a.tonsMax} t`} bad={tonsLeft < -1e-6} hint={t('stat.weight-hint', { structure: fixed(a.mass.structure, 2), armor: fixed(a.mass.armor, 2), engine: fixed(a.mass.engine, 2), items: fixed(a.mass.items, 2), fixed: fixed(a.mass.fixed, 2) })} />
      <Stat label={t('stat.slots')} value={`${a.slotsUsed + a.dynamicSlots} / ${a.slotsTotal}`} bad={a.slotsUsed + a.dynamicSlots > a.slotsTotal} hint={t('stat.slots-hint', { count: a.dynamicSlots })} />
      <Stat label={t('stat.armor')} value={`${a.armorPoints} / ${a.armorMaxPoints}`} />
      <Stat label={t('stat.speed')} value={`${fixed(a.speed, 1)} km/h`} hint={t('stat.speed-hint')} />
      <Stat label={t('stat.weapons')} value={`${a.weaponCount} / ${ASSUMPTIONS.maxWeapons}`} bad={a.weaponCount > ASSUMPTIONS.maxWeapons} hint={t('stat.weapons-hint')} />
      <Stat label={t('stat.alpha')} value={fixed(a.alpha, 1)} hint={t('stat.alpha-hint')} />
      <Stat label={t('stat.dps')} value={fixed(a.dps, 2)} hint={t('stat.dps-hint')} />
      <Stat label={t('stat.hps')} value={fixed(a.hps, 2)} hint={t('stat.hps-hint')} />
      <Stat label={t('stat.cooling')} value={fixed(a.cooling, 2)} hint={t('stat.cooling-hint', { total: a.heatSinks.total, engine: a.heatSinks.inEngine })} />
      <Stat label={t('stat.capacity')} value={fixed(a.heatCapacity, 1)} hint={t('stat.capacity-hint')} />
    </div>
  );
}

function Loadout({ mech, build, setBuild, catalog, ix, a }: { mech: MechDetail; build: Build; setBuild: (b: Build) => void; catalog: Catalog; ix: GameIndex; a: Analysis }) {
  const m = mech.mech;
  const ups = (t: Upgrade['type']) => catalog.upgrades.filter((u) => u.type === t && (u.faction === 'Both' || u.faction === m.faction));
  const engines = useMemo(() => catalog.items.filter((i): i is Engine =>
    i.kind === 'engine' && factionMatches(i.faction, m.faction) && i.rating >= m.minEngine && i.rating <= m.maxEngine), [catalog, m]);
  const engineTypes = [...new Set(engines.map((e) => e.engineType))];
  const fixedEngine = a.components.some((c) => c.fixedItems.some((i) => i.kind === 'engine'));
  const cur = a.engine;
  const pickEngine = (type: string, rating: number) => {
    const list = engines.filter((e) => e.engineType === type);
    const e = list.find((x) => x.rating === rating) ?? list[0];
    if (e) setBuild({ ...build, engineId: e.id });
  };
  const hsItem = ix.items.get(ix.upgrades.get(build.heatSinkType)?.compatibleHeatSink ?? -1);
  return (
    <div className="panel loadout">
      <h3>{t('tech.title')}</h3>
      {fixedEngine ? (
        <p className="muted">{t('tech.fixed-engine', { engine: cur?.label ?? '' })}</p>
      ) : (
        <div className="field-row">
          <label className="field">{t('tech.engine')}
            <select value={cur?.engineType ?? ''} onChange={(e) => pickEngine(e.target.value, cur?.rating ?? m.minEngine)}>
              {engineTypes.map((type) => <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <label className="field">{t('tech.rating')}
            <select value={cur?.rating ?? ''} onChange={(e) => pickEngine(cur?.engineType ?? engineTypes[0]!, Number(e.target.value))}>
              {engines.filter((e) => e.engineType === cur?.engineType).map((e) => <option key={e.id} value={e.rating}>{e.rating} ({num(e.tons)} t)</option>)}
            </select>
          </label>
        </div>
      )}
      {m.isOmni ? (
        <p className="muted">{t('tech.omni-fixed')}</p>
      ) : (
        <>
          <label className="field">{t('tech.armor')}
            <select value={build.armorType} onChange={(e) => setBuild({ ...build, armorType: Number(e.target.value) })}>
              {ups('Armor').map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
          <label className="field">{t('tech.structure')}
            <select value={build.structureType} onChange={(e) => setBuild({ ...build, structureType: Number(e.target.value) })}>
              {ups('Structure').map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
          <label className="field">{t('tech.heatsinks')}
            <select value={build.heatSinkType} onChange={(e) => {
              const next = Number(e.target.value);
              const to = ix.upgrades.get(next)?.compatibleHeatSink;
              const from = ix.upgrades.get(build.heatSinkType)?.compatibleHeatSink;
              const items = Object.fromEntries(Object.entries(build.items).map(([k, v]) => [k, v.map((id) => (id === from && to ? to : id))]));
              setBuild({ ...build, heatSinkType: next, items });
            }}>
              {ups('HeatSink').map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
        </>
      )}
      <label className="check"><input type="checkbox" checked={build.artemis} onChange={(e) => setBuild(setArtemis(build, e.target.checked, ix))} /> {t('tech.artemis')}</label>
      {hsItem && <p className="muted small-text">{t('tech.heatsink', { name: hsItem.label })}</p>}
    </div>
  );
}

function Weapons({ a }: { a: Analysis }) {
  if (a.weapons.length === 0) return <section className="panel weapons"><h3>{t('weapons.title')}</h3><p className="muted">{t('weapons.none')}</p></section>;
  return (
    <section className="panel weapons">
      <h3>{t('weapons.title-quirks')}</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{t('weapons.weapon')}</th><th className="num">×</th><th className="num">{t('weapons.damage')}</th><th className="num">{t('weapons.heat')}</th><th className="num">{t('weapons.cooldown')}</th><th className="num">{t('weapons.optimal')}</th><th className="num">{t('weapons.max')}</th><th className="num">{t('stat.dps')}</th></tr></thead>
          <tbody>
            {a.weapons.map((w) => (
              <tr key={w.weapon.id} title={w.sources.map((s) => `${formatQuirkValue(s.quirk, getLocale())} ${quirkLabel(s.quirk, getLocale())} (${formatSource(s.source, getLocale())})`).join('\n') || t('weapons.no-quirks')}>
                <td><span className={`dot hp-${w.weapon.hardpoint}`} />{w.weapon.label}</td>
                <td className="num">{w.count}</td>
                <td className="num">{num(w.damage)}</td>
                <td className="num">{num(w.heat)}</td>
                <td className="num">{num(w.cooldown)}</td>
                <td className="num">{Math.round(w.optimalRange)}</td>
                <td className="num">{Math.round(w.maxRange)}</td>
                <td className="num">{fixed(w.dps * w.count, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Quirks({ a }: { a: Analysis }) {
  const groups = useMemo(() => {
    const map = new Map<string, Analysis['quirks']>();
    for (const q of a.quirks) {
      const source = formatSource(q.source, getLocale());
      if (!map.has(source)) map.set(source, []);
      map.get(source)!.push(q);
    }
    return [...map];
  }, [a.quirks, getLocale()]);
  return (
    <section className="panel quirks">
      <h3>{t('quirks.title')} <span className="muted">({a.quirks.length})</span></h3>
      {groups.length === 0 && <p className="muted">{t('quirks.none')}</p>}
      <div className="quirk-groups">
        {groups.map(([source, qs]) => (
          <div key={source}>
            <h4>{source}</h4>
            <ul>{qs.map((q, i) => <li key={i} title={q.quirk.raw}><strong>{formatQuirkValue(q.quirk, getLocale())}</strong> {quirkLabel(q.quirk, getLocale())}</li>)}</ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function Skills({ catalog, build, setBuild, a, ix, mech }: { catalog: Catalog; build: Build; setBuild: (b: Build) => void; a: Analysis; ix: GameIndex; mech: Mech }) {
  const [open, setOpen] = useState(false);
  const max = ASSUMPTIONS.maxSkillNodes;
  const remaining = max - a.skillNodes;
  const categories = useMemo(() => {
    const map = new Map<string, SkillNode[]>();
    for (const s of catalog.skills) map.set(s.category, [...(map.get(s.category) ?? []), s]);
    return [...map];
  }, [catalog]);
  const set = (node: SkillNode, n: number) => {
    const current = build.skills[node.group] ?? 0;
    const v = Math.max(0, Math.min(node.names.length, Math.min(n, current + remaining)));
    const skills = { ...build.skills };
    if (v === 0) delete skills[node.group];
    else skills[node.group] = v;
    setBuild({ ...build, skills });
  };
  const perNode = (s: SkillNode) => s.effects
    .map((e) => ({ ...e.quirk, value: resolveSkillValue(e, mech) }))
    .filter((q) => q.value !== 0)
    .map((q) => `${formatQuirkValue(q, getLocale())} ${quirkLabel(q, getLocale())}`)
    .join('\n');
  return (
    <section className="panel skills">
      <h3>
        <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {t('skills.title')}</button>{' '}
        <span className={remaining === 0 ? 'strong' : 'muted'}>{t('skills.count', { used: a.skillNodes, max })}</span>
      </h3>
      {open && (
        <>
          <div className="skill-actions">
            <button disabled={a.skillNodes === 0} onClick={() => setBuild({ ...build, skills: {} })}>{t('skills.reset')}</button>
            <span className="muted small-text">{t('skills.path-note')}</span>
          </div>
          <div className="skill-categories">
            {categories.map(([category, nodes]) => {
              const used = nodes.reduce((sum, n) => sum + (skillAvailable(n, build, ix) ? Math.min(build.skills[n.group] ?? 0, n.names.length) : 0), 0);
              return (
                <div key={category} className="skill-category">
                  <h4>{category} <span className="muted">{used}</span></h4>
                  {nodes.map((s) => {
                    const available = skillAvailable(s, build, ix);
                    const value = available ? (build.skills[s.group] ?? 0) : 0;
                    return (
                      <label key={s.group} className={`skill-row ${available ? '' : 'locked'}`} title={available ? `${t('skills.per-node')}\n${perNode(s)}` : t('skills.locked')}>
                        <span className="skill-name">{s.label}</span>
                        <input type="number" min={0} max={s.names.length} disabled={!available} value={value} aria-label={s.label} onChange={(e) => set(s, Number(e.target.value))} />
                        <span className="muted">/{s.names.length}</span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
