import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  baseWeaponStats, componentLabel, formatQuirkValue, formatSource, HARDPOINT_TYPES, quirkLabel, WEAPON_STAT_KEYS, weaponFamilies, weaponStatLowerIsBetter,
  type Faction, type Weapon, type WeaponQuery, type WeaponRow, type WeaponStatKey, type WeightClass,
} from '@mwo/shared';
import { api, type Catalog } from './api.ts';
import { go } from './App.tsx';
import { fixed, getLocale, t, type UiKey } from './i18n.ts';
import { HardpointBadges, WEIGHTS } from './SearchPage.tsx';

const STORAGE_KEY = 'mwo.weapons.v1';
const DECIMALS: Record<WeaponStatKey, number> = { maxRange: 0, optimalRange: 0, damage: 2, cooldown: 2, duration: 2, heat: 2, velocity: 0, dps: 2, hps: 2 };
const statText = (key: WeaponStatKey) => t(`overview.stat.${key}` as UiKey);
const statValue = (key: WeaponStatKey, v: number) => (v === 0 ? '–' : fixed(v, DECIMALS[key]));

interface Saved { family: string; sortBy: WeaponStatKey; minCount: number; filters: WeaponQuery['filters'] }
const DEFAULTS: Saved = { family: 'erlargelaser', sortBy: 'maxRange', minCount: 1, filters: {} };
function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Saved>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function WeaponsPage({ catalog }: { catalog: Catalog }) {
  const weapons = useMemo(() => catalog.items.filter((i): i is Weapon => i.kind === 'weapon'), [catalog]);
  const families = useMemo(() => weaponFamilies(weapons), [weapons]);
  const initial = useMemo(loadSaved, []);
  const [familyId, setFamilyId] = useState(families.some((f) => f.id === initial.family) ? initial.family : DEFAULTS.family);
  const [sortBy, setSortBy] = useState<WeaponStatKey>(initial.sortBy);
  const [minCount, setMinCount] = useState(initial.minCount);
  const [filters, setFilters] = useState<WeaponQuery['filters']>(initial.filters);
  const [rows, setRows] = useState<WeaponRow[]>([]);
  const [total, setTotal] = useState(0);
  const [ms, setMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const family = families.find((f) => f.id === familyId) ?? families[0]!;
  const members = useMemo(
    () => family.weapons.map((n) => weapons.find((w) => w.name === n)!).filter((w) => !filters.faction || w.faction === 'Both' || w.faction === filters.faction),
    [family, weapons, filters.faction],
  );
  const baseOf = useMemo(() => new Map(weapons.map((w) => [w.id, baseWeaponStats(w)])), [weapons]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ family: familyId, sortBy, minCount, filters }));
    } catch { /* optional */ }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api.weapons({ weapons: family.weapons, sortBy, minCount, filters, limit: 200 })
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
      clearTimeout(timer);
    };
  }, [family, familyId, sortBy, minCount, filters]);

  const toggleWeight = (w: WeightClass) => {
    const cur = filters.weightClasses ?? [];
    setFilters({ ...filters, weightClasses: cur.includes(w) ? cur.filter((x) => x !== w) : [...cur, w] });
  };
  const openInLab = (r: WeaponRow) => {
    const pods = r.pods.map((p) => `${p.component}:${p.podId}`).join(',');
    go(`#/mechlab/${r.variant}${pods ? `?pods=${pods}` : ''}`);
  };
  const columns = WEAPON_STAT_KEYS.length + 5;

  return (
    <div className="search-layout">
      <aside className="panel filters">
        <section>
          <label className="field">{t('overview.weapon')}
            <select className="weapon-select" value={family.id} onChange={(e) => { setFamilyId(e.target.value); setOpen(null); }}>
              {HARDPOINT_TYPES.map((type) => (
                <optgroup key={type} label={t(`hp.${type}`)}>
                  {families.filter((f) => f.hardpoint === type).map((f) => (
                    <option key={f.id} value={f.id}>{f.label} ({f.weapons.length > 1 ? t('overview.both') : f.factions[0] === 'Clan' ? 'Clan' : 'IS'})</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <p className="hint">{t('overview.hint')}</p>
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
              {WEIGHTS.map((w) => <button key={w.id} className={filters.weightClasses?.includes(w.id) ? 'on' : ''} onClick={() => toggleWeight(w.id)}>{w.label}</button>)}
            </div>
          </div>
          <label className="field">{t('overview.min-count')}
            <input type="number" min={1} max={16} value={minCount} onChange={(e) => setMinCount(Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className="check"><input type="checkbox" checked={!!filters.requireJumpJets} onChange={(e) => setFilters({ ...filters, requireJumpJets: e.target.checked || undefined })} /> {t('search.jj')}</label>
          <label className="field">{t('search.type')}
            <select value={filters.omni ?? 'any'} onChange={(e) => setFilters({ ...filters, omni: e.target.value as WeaponQuery['filters']['omni'] })}>
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
        </div>
        {error && <div className="banner error">{error}</div>}
        <div className="table-wrap">
          <table className="results-table weapons-table">
            <thead>
              <tr>
                <th>{t('search.col-mech')}</th><th className="num">t</th><th title="Ballistic / Energy / Missile / AMS">{t('search.col-hp')}</th>
                <th className="num" title={t('overview.count-title')}>{t('overview.col-count')}</th>
                {WEAPON_STAT_KEYS.map((key) => (
                  <th key={key} className="num" aria-sort={sortBy === key ? (weaponStatLowerIsBetter(key) ? 'ascending' : 'descending') : 'none'}>
                    <button className={`sort-head ${sortBy === key ? 'on' : ''}`} title={t('overview.sort-title')} onClick={() => setSortBy(key)}>{statText(key)}{sortBy === key ? (weaponStatLowerIsBetter(key) ? ' ↑' : ' ↓') : ''}</button>
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((w) => (
                <tr key={w.id} className="base-row">
                  <td colSpan={4}>{t('overview.base')}: {w.label}</td>
                  {WEAPON_STAT_KEYS.map((key) => <td key={key} className="num">{statValue(key, baseOf.get(w.id)![key])}</td>)}
                  <td />
                </tr>
              ))}
              {rows.map((r) => {
                const isOpen = open === r.variant;
                const base = baseOf.get(r.weaponId)!;
                return (
                  <Fragment key={r.variant}>
                    <tr className={`row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : r.variant)}>
                      <td>
                        <div className="mech-name">{r.label}{r.isOmni && <span className="tag">Omni</span>}{r.variantType && <span className="tag alt">{r.variantType}</span>}</div>
                        <div className="mech-sub">
                          {r.faction === 'Clan' ? 'Clan' : 'Inner Sphere'}
                          {r.alsoVariants.length > 0 && ` · ${t(r.isOmni ? 'search.more-variants' : 'search.equal', { count: r.alsoVariants.length })}`}
                        </div>
                      </td>
                      <td className="num">{r.tons}</td>
                      <td><HardpointBadges hp={r.hardpoints} /></td>
                      <td className="num">{r.mountable}</td>
                      {WEAPON_STAT_KEYS.map((key) => {
                        const changed = Math.abs(r.stats[key] - base[key]) > 1e-9;
                        return <td key={key} className={`num ${changed ? 'strong' : 'muted'} ${sortBy === key ? 'sorted' : ''}`}>{statValue(key, r.stats[key])}</td>;
                      })}
                      <td className="num"><button className="primary small" onClick={(e) => { e.stopPropagation(); openInLab(r); }}>{t('search.open-lab')}</button></td>
                    </tr>
                    {isOpen && (
                      <tr className="detail"><td colSpan={columns}>
                        <div className="detail-grid">
                          <div>
                            <h4>{t('overview.applied')}</h4>
                            {r.sources.length === 0 && <p className="muted">{t('overview.no-quirks')}</p>}
                            <ul>{r.sources.map((s, j) => <li key={j}><strong>{formatQuirkValue(s.quirk, getLocale())}</strong> {quirkLabel(s.quirk, getLocale())} · {formatSource(s.source, getLocale())}</li>)}</ul>
                          </div>
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
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {!loading && rows.length === 0 && <tr><td colSpan={columns} className="empty">{t('overview.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
