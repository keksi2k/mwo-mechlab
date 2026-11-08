import { useEffect, useMemo, useState } from 'react';
import {
  ASSUMPTIONS, componentLabel, defaultDir, formatQuirkValue, formatSource, HARDPOINT_TYPES, quirkLabel, statLabel, weaponCounterparts,
  type Criterion, type CriterionValue, type Faction, type HardpointType, type MechField, type SearchFilters, type SearchRow, type Weapon, type WeightClass,
} from '@mwo/shared';
import { api, type Catalog } from './api.ts';
import { go } from './App.tsx';
import { getLocale, num, t } from './i18n.ts';

const HP_SHORT: Record<HardpointType, string> = { ballistic: 'B', energy: 'E', missile: 'M', ams: 'AMS' };
export const WEIGHTS: { id: WeightClass; label: string }[] = [
  { id: 'light', label: 'Light' }, { id: 'medium', label: 'Medium' }, { id: 'heavy', label: 'Heavy' }, { id: 'assault', label: 'Assault' },
];
const MECH_FIELDS: MechField[] = ['maxSpeed', 'tons', 'maxEngine', 'maxJumpJets', 'torsoYaw', 'torsoYawSpeed', 'armYaw'];
const hpLabel = (type: HardpointType) => t(`hp.${type}`);
const fieldLabel = (field: MechField) => t(`field.${field}`);

const STORAGE_KEY = 'mwo.search.v1';
interface Saved { filters: SearchFilters; criteria: Criterion[] }
function loadSaved(fallback: Saved): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Saved) : fallback;
  } catch {
    return fallback;
  }
}

export function SearchPage({ catalog }: { catalog: Catalog }) {
  const weapons = useMemo(() => catalog.items.filter((i): i is Weapon => i.kind === 'weapon').sort((a, b) => a.label.localeCompare(b.label)), [catalog]);
  const initial = useMemo(() => {
    const ams = catalog.presets[0]!;
    return loadSaved({ filters: ams.filters, criteria: ams.criteria });
  }, [catalog]);
  const [filters, setFilters] = useState<SearchFilters>(initial.filters);
  const [criteria, setCriteria] = useState<Criterion[]>(initial.criteria);
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [ms, setMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ filters, criteria }));
    } catch { /* optional */ }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api.search({ filters, criteria, limit: 200 })
        .then((r) => {
          if (cancelled) return;
          setRows(r.rows);
          setTotal(r.total);
          setMs(r.ms);
          setError(null);
        })
        .catch((e: Error) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [filters, criteria]);

  const criterionLabel = (c: Criterion): string => {
    if (c.kind === 'hardpoints') return t('search.crit-hardpoints', { type: hpLabel(c.type) });
    if (c.kind === 'quirk') {
      const q = catalog.quirks.find((x) => x.key === c.key);
      return q ? quirkLabel(q, getLocale()) : c.key;
    }
    if (c.kind === 'mech') return fieldLabel(c.field);
    const w = weapons.find((x) => x.name === c.weapons[0]);
    return `${w?.label ?? c.weapons[0]}: ${statLabel(c.stat, getLocale())}${c.includeGlobal ? t('search.crit-global') : ''}`;
  };

  const update = (i: number, next: Criterion) => setCriteria(criteria.map((c, j) => (j === i ? next : c)));
  const move = (i: number, d: number) => {
    const next = [...criteria];
    const [c] = next.splice(i, 1);
    next.splice(i + d, 0, c!);
    setCriteria(next);
  };
  const setHp = (type: HardpointType, v: string) => {
    const min = { ...filters.minHardpoints };
    if (v === '' || Number(v) <= 0) delete min[type];
    else min[type] = Number(v);
    setFilters({ ...filters, minHardpoints: min });
  };
  const toggleWeight = (w: WeightClass) => {
    const cur = filters.weightClasses ?? [];
    setFilters({ ...filters, weightClasses: cur.includes(w) ? cur.filter((x) => x !== w) : [...cur, w] });
  };

  const openInLab = (r: SearchRow) => {
    const pods = r.pods.map((p) => `${p.component}:${p.podId}`).join(',');
    go(`#/mechlab/${r.variant}${pods ? `?pods=${pods}` : ''}`);
  };

  return (
    <div className="search-layout">
      <aside className="panel filters">
        <section>
          <h3>{t('search.presets')}</h3>
          <div className="presets">
            {catalog.presets.map((p) => (
              <button key={p.id} title={p.description[getLocale()]} onClick={() => { setFilters(p.filters); setCriteria(p.criteria); }}>{p.label[getLocale()]}</button>
            ))}
          </div>
        </section>

        <section>
          <h3>{t('search.sort')}</h3>
          <p className="hint">{t('search.sort-hint')}</p>
          <ol className="criteria">
            {criteria.map((c, i) => {
              const dir = defaultDir(c);
              return (
                <li key={`${i}-${JSON.stringify(c)}`}>
                  <span className="criterion-label">{criterionLabel(c)}</span>
                  <span className="criterion-actions">
                    <button title={t('search.dir-title')} onClick={() => update(i, { ...c, dir: dir === 'asc' ? 'desc' : 'asc' })}>{dir === 'asc' ? t('search.dir-asc') : t('search.dir-desc')}</button>
                    <button disabled={i === 0} title={t('search.up')} onClick={() => move(i, -1)}>↑</button>
                    <button disabled={i === criteria.length - 1} title={t('search.down')} onClick={() => move(i, 1)}>↓</button>
                    <button title={t('search.remove')} onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}>×</button>
                  </span>
                </li>
              );
            })}
            {criteria.length === 0 && <li className="hint">{t('search.no-criteria')}</li>}
          </ol>
          <AddCriterion catalog={catalog} weapons={weapons} onAdd={(c) => setCriteria([...criteria, c])} />
        </section>

        <section>
          <h3>{t('search.filter')}</h3>
          <label className="field">{t('search.name')}
            <input value={filters.text ?? ''} placeholder={t('search.name-placeholder')} onChange={(e) => setFilters({ ...filters, text: e.target.value || undefined })} />
          </label>
          <label className="field">{t('search.faction')}
            <select value={filters.faction ?? ''} onChange={(e) => setFilters({ ...filters, faction: (e.target.value || undefined) as Faction | undefined })}>
              <option value="">{t('search.all')}</option><option value="InnerSphere">Inner Sphere</option><option value="Clan">Clan</option>
            </select>
          </label>
          <div className="field">{t('search.weight')}
            <div className="chips">
              {WEIGHTS.map((w) => (
                <button key={w.id} className={filters.weightClasses?.includes(w.id) ? 'on' : ''} onClick={() => toggleWeight(w.id)}>{w.label}</button>
              ))}
            </div>
          </div>
          <div className="field-row">
            <label className="field">{t('search.min-tons')}<input type="number" min={20} max={100} step={5} value={filters.minTons ?? ''} onChange={(e) => setFilters({ ...filters, minTons: e.target.value ? Number(e.target.value) : undefined })} /></label>
            <label className="field">{t('search.max-tons')}<input type="number" min={20} max={100} step={5} value={filters.maxTons ?? ''} onChange={(e) => setFilters({ ...filters, maxTons: e.target.value ? Number(e.target.value) : undefined })} /></label>
          </div>
          <div className="field">{t('search.min-hardpoints')}
            <div className="hp-inputs">
              {HARDPOINT_TYPES.map((type) => (
                <label key={type} className={`hp hp-${type}`}>{HP_SHORT[type]}
                  <input type="number" min={0} max={16} value={filters.minHardpoints?.[type] ?? ''} onChange={(e) => setHp(type, e.target.value)} />
                </label>
              ))}
            </div>
          </div>
          <label className="check"><input type="checkbox" checked={!!filters.requireECM} onChange={(e) => setFilters({ ...filters, requireECM: e.target.checked || undefined })} /> {t('search.ecm')}</label>
          <label className="check"><input type="checkbox" checked={!!filters.requireJumpJets} onChange={(e) => setFilters({ ...filters, requireJumpJets: e.target.checked || undefined })} /> {t('search.jj')}</label>
          <label className="check"><input type="checkbox" checked={!!filters.requireQuirkMatch} onChange={(e) => setFilters({ ...filters, requireQuirkMatch: e.target.checked || undefined })} /> {t('search.quirk-only')}</label>
          <label className="field">{t('search.type')}
            <select value={filters.omni ?? 'any'} onChange={(e) => setFilters({ ...filters, omni: e.target.value as SearchFilters['omni'] })}>
              <option value="any">{t('search.all')}</option><option value="none">{t('search.battlemechs')}</option><option value="only">{t('search.omnimechs')}</option>
            </select>
          </label>
        </section>
      </aside>

      <section className="results">
        <div className="results-head">
          <strong>{t('search.hits', { count: total })}</strong>
          {total > rows.length && <span className="muted">{t('search.first', { count: rows.length })}</span>}
          <span className="muted"> · {loading ? t('search.searching') : `${ms} ms`}</span>
          <span className="muted right">{t('search.omni-note')}</span>
        </div>
        {error && <div className="banner error">{error}</div>}
        <div className="table-wrap">
          <table className="results-table">
            <thead>
              <tr>
                <th>{t('search.col-mech')}</th><th className="num">t</th><th title="Ballistic / Energy / Missile / AMS">{t('search.col-hp')}</th>
                {criteria.map((c, i) => <th key={i} className="num crit-head">{criterionLabel(c)}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = open === r.variant;
                return (
                  <FragmentRow key={r.variant} r={r} isOpen={isOpen} columns={criteria.length + 4} criteria={criteria} criterionLabel={criterionLabel}
                    onToggle={() => setOpen(isOpen ? null : r.variant)} onOpenLab={() => openInLab(r)} />
                );
              })}
              {!loading && rows.length === 0 && <tr><td colSpan={criteria.length + 4} className="empty">{t('search.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function formatValue(v: CriterionValue): string {
  if (v.kind === 'count') return String(v.value);
  if (v.kind === 'number') return num(v.value, 1);
  if (v.value === 0) return '–';
  return formatQuirkValue({ kind: v.kind, value: v.value }, getLocale());
}

function FragmentRow({ r, isOpen, columns, criteria, criterionLabel, onToggle, onOpenLab }: {
  r: SearchRow; isOpen: boolean; columns: number; criteria: Criterion[]; criterionLabel: (c: Criterion) => string; onToggle: () => void; onOpenLab: () => void;
}) {
  const totalHardpoints = HARDPOINT_TYPES.reduce((sum, type) => sum + r.hardpoints[type], 0);
  const overLimit = totalHardpoints > ASSUMPTIONS.maxWeapons;
  return (
    <>
      <tr className={`row ${isOpen ? 'open' : ''}`} onClick={onToggle}>
        <td>
          <div className="mech-name">{r.label}{r.isOmni && <span className="tag">Omni</span>}{r.variantType && <span className="tag alt">{r.variantType}</span>}</div>
          <div className="mech-sub">
            {r.faction === 'Clan' ? 'Clan' : 'Inner Sphere'}
            {r.canEquipECM && ' · ECM'}
            {r.maxJumpJets > 0 && ` · ${r.maxJumpJets} JJ`}
            {r.alsoVariants.length > 0 && ` · ${t(r.isOmni ? 'search.more-variants' : 'search.equal', { count: r.alsoVariants.length })}`}
          </div>
        </td>
        <td className="num">{r.tons}</td>
        <td>
          <HardpointBadges hp={r.hardpoints} />
          {overLimit && <div className="limit-hint" title={t('search.over-limit', { total: totalHardpoints, max: ASSUMPTIONS.maxWeapons })}>{t('search.over-limit-tag', { max: ASSUMPTIONS.maxWeapons })}</div>}
        </td>
        {r.values.map((v, i) => <td key={i} className={`num ${v.value !== 0 ? 'strong' : 'muted'}`}>{formatValue(v)}</td>)}
        <td className="num"><button className="primary small" onClick={(e) => { e.stopPropagation(); onOpenLab(); }}>{t('search.open-lab')}</button></td>
      </tr>
      {isOpen && (
        <tr className="detail"><td colSpan={columns}>
          <div className="detail-grid">
            {r.values.map((v, i) => v.sources.length > 0 && (
              <div key={i}>
                <h4>{criterionLabel(criteria[i]!)}</h4>
                <ul>{v.sources.map((s, j) => <li key={j}><strong>{formatQuirkValue(s, getLocale())}</strong> {formatSource(s.source, getLocale())} <span className="muted">{s.raw}</span></li>)}</ul>
              </div>
            ))}
            {r.pods.length > 0 && (
              <div>
                <h4>{t('search.best-pods')}</h4>
                <ul>{r.pods.map((p) => <li key={p.component}>{componentLabel(p.component, getLocale())}: <strong>{p.set.toUpperCase()}</strong></li>)}</ul>
              </div>
            )}
            {r.alsoVariants.length > 0 && (
              <div>
                <h4>{t(r.isOmni ? 'search.other-variants' : 'search.equal-variants')}</h4>
                <p className="muted">{r.alsoVariants.map((v) => v.toUpperCase()).join(', ')}</p>
              </div>
            )}
            {r.values.every((v) => v.sources.length === 0) && r.pods.length === 0 && r.alsoVariants.length === 0 && <p className="muted">{t('search.no-quirks')}</p>}
          </div>
        </td></tr>
      )}
    </>
  );
}

export function HardpointBadges({ hp }: { hp: Record<HardpointType, number> }) {
  return (
    <span className="badges">
      {HARDPOINT_TYPES.map((type) => <span key={type} className={`hp hp-${type} ${hp[type] === 0 ? 'zero' : ''}`} title={hpLabel(type)}>{hp[type]}{HP_SHORT[type]}</span>)}
    </span>
  );
}

function AddCriterion({ catalog, weapons, onAdd }: { catalog: Catalog; weapons: Weapon[]; onAdd: (c: Criterion) => void }) {
  const [kind, setKind] = useState<Criterion['kind']>('weaponQuirk');
  const [weapon, setWeapon] = useState('AntiMissileSystem');
  const [stat, setStat] = useState('range');
  const [global, setGlobal] = useState(false);
  const [hp, setHp] = useState<HardpointType>('energy');
  const [field, setField] = useState<MechField>('maxSpeed');
  const [quirkText, setQuirkText] = useState('');

  const matches = useMemo(() => {
    const needle = quirkText.trim().toLowerCase();
    if (!needle) return [];
    return catalog.quirks.filter((q) => quirkLabel(q, getLocale()).toLowerCase().includes(needle) || q.label.toLowerCase().includes(needle) || q.key.includes(needle)).slice(0, 8);
  }, [quirkText, catalog]);

  return (
    <div className="add-criterion">
      <select value={kind} onChange={(e) => setKind(e.target.value as Criterion['kind'])}>
        <option value="weaponQuirk">{t('crit.weapon')}</option>
        <option value="quirk">{t('crit.quirk')}</option>
        <option value="hardpoints">{t('crit.hardpoints')}</option>
        <option value="mech">{t('crit.mech')}</option>
      </select>
      {kind === 'weaponQuirk' && (
        <>
          <select value={weapon} onChange={(e) => setWeapon(e.target.value)}>
            {weapons.map((w) => <option key={w.id} value={w.name}>{w.label} ({w.faction === 'Clan' ? 'Clan' : w.faction === 'Both' ? t('crit.both') : 'IS'})</option>)}
          </select>
          <select value={stat} onChange={(e) => setStat(e.target.value)}>
            {catalog.weaponStats.map((s) => <option key={s} value={s}>{statLabel(s, getLocale())}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> {t('crit.global')}</label>
          <button onClick={() => onAdd({ kind: 'weaponQuirk', weapons: weaponCounterparts(weapon, weapons), stat, includeGlobal: global || undefined })}>{t('crit.add')}</button>
        </>
      )}
      {kind === 'hardpoints' && (
        <>
          <select value={hp} onChange={(e) => setHp(e.target.value as HardpointType)}>
            {HARDPOINT_TYPES.map((type) => <option key={type} value={type}>{hpLabel(type)}</option>)}
          </select>
          <button onClick={() => onAdd({ kind: 'hardpoints', type: hp })}>{t('crit.add')}</button>
        </>
      )}
      {kind === 'mech' && (
        <>
          <select value={field} onChange={(e) => setField(e.target.value as MechField)}>
            {MECH_FIELDS.map((f) => <option key={f} value={f}>{fieldLabel(f)}</option>)}
          </select>
          <button onClick={() => onAdd({ kind: 'mech', field })}>{t('crit.add')}</button>
        </>
      )}
      {kind === 'quirk' && (
        <>
          <input value={quirkText} placeholder={t('crit.quirk-placeholder')} onChange={(e) => setQuirkText(e.target.value)} />
          {matches.length > 0 && (
            <ul className="quirk-matches">
              {matches.map((q) => (
                <li key={q.key}><button onClick={() => { onAdd({ kind: 'quirk', key: q.key }); setQuirkText(''); }}>{quirkLabel(q, getLocale())} <span className="muted">{q.count}×</span></button></li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
