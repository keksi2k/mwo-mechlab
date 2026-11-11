import { Fragment, useEffect, useState } from 'react';
import { HARDPOINT_TYPES, type AlphaOptions, type AlphaQuery, type AlphaRow, type Faction, type HardpointType, type WeightClass } from '@mwo/shared';
import { api } from './api.ts';
import { go } from './App.tsx';
import { fixed, num, t } from './i18n.ts';
import { WEIGHTS } from './SearchPage.tsx';

const STORAGE_KEY = 'mwo.alpha.v1';
const WEAPON_TYPES = HARDPOINT_TYPES.filter((h): h is Exclude<HardpointType, 'ams'> => h !== 'ams');

interface Saved { options: AlphaOptions; filters: AlphaQuery['filters'] }
const DEFAULTS: Saved = { options: {}, filters: {} };
function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Saved>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function AlphaPage() {
  const [initial] = useState(loadSaved);
  const [options, setOptions] = useState<AlphaOptions>(initial.options);
  const [filters, setFilters] = useState<AlphaQuery['filters']>(initial.filters);
  const [rows, setRows] = useState<AlphaRow[]>([]);
  const [total, setTotal] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ options, filters }));
    } catch { /* optional */ }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      api.alpha({ options, filters, limit: 300 })
        .then((r) => {
          if (cancelled) return;
          setError(null);
          if (r.status === 'ready') {
            setRows(r.rows);
            setTotal(r.total);
            setProgress(null);
          } else {
            setProgress({ done: r.done, total: r.total });
            timer = setTimeout(poll, 1500);
          }
        })
        .catch((e: Error) => !cancelled && setError(e.message));
    };
    timer = setTimeout(poll, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [options, filters]);

  const toggleType = (h: Exclude<HardpointType, 'ams'>) => {
    const cur = options.hardpointTypes ?? [];
    const next = cur.includes(h) ? cur.filter((x) => x !== h) : [...cur, h];
    setOptions({ ...options, hardpointTypes: next.length ? next : undefined });
  };
  const toggleWeight = (w: WeightClass) => {
    const cur = filters.weightClasses ?? [];
    setFilters({ ...filters, weightClasses: cur.includes(w) ? cur.filter((x) => x !== w) : [...cur, w] });
  };
  // Each change of options starts a calculation of several minutes, so numbers apply on Enter or when leaving the field
  const [draft, setDraft] = useState({ minRange: String(initial.options.minRange ?? ''), minSpeed: String(initial.options.minSpeed ?? '') });
  const commit = (key: 'minRange' | 'minSpeed') => {
    const n = Number(draft[key]);
    const value = draft[key] === '' || !Number.isFinite(n) || n <= 0 ? undefined : n;
    if (value !== options[key]) setOptions({ ...options, [key]: value });
  };
  const openInLab = (r: AlphaRow) => {
    if (r.code) go(`#/mechlab/${r.variant}?code=${encodeURIComponent(r.code)}`);
    else go(`#/mechlab/${r.variant}?pods=${Object.entries(r.build.pods).map(([c, id]) => `${c}:${id}`).join(',')}`);
  };
  const columns = 7;

  return (
    <div className="search-layout">
      <aside className="panel filters">
        <section>
          <h3>{t('alpha.title')}</h3>
          <p className="hint">{t('alpha.hint')}</p>
          <div className="field">{t('alpha.weapon-types')}
            <div className="chips">
              {WEAPON_TYPES.map((h) => <button key={h} className={options.hardpointTypes?.includes(h) ? 'on' : ''} onClick={() => toggleType(h)}>{t(`hp.${h}`)}</button>)}
            </div>
          </div>
          <label className="field">{t('alpha.min-range')}
            <input type="number" min={0} step={50} value={draft.minRange} placeholder="0" onChange={(e) => setDraft({ ...draft, minRange: e.target.value })}
              onBlur={() => commit('minRange')} onKeyDown={(e) => { if (e.key === 'Enter') commit('minRange'); }} />
          </label>
          <label className="field">{t('alpha.min-speed')}
            <input type="number" min={0} step={5} value={draft.minSpeed} placeholder="0" onChange={(e) => setDraft({ ...draft, minSpeed: e.target.value })}
              onBlur={() => commit('minSpeed')} onKeyDown={(e) => { if (e.key === 'Enter') commit('minSpeed'); }} />
          </label>
          <label className="check" title={t('alpha.mix-hint')}>
            <input type="checkbox" checked={!!options.mixGhostGroups} onChange={(e) => setOptions({ ...options, mixGhostGroups: e.target.checked || undefined })} /> {t('alpha.mix')}
          </label>
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
          <label className="field">{t('search.type')}
            <select value={filters.omni ?? 'any'} onChange={(e) => setFilters({ ...filters, omni: e.target.value as AlphaQuery['filters']['omni'] })}>
              <option value="any">{t('search.all')}</option><option value="none">{t('search.battlemechs')}</option><option value="only">{t('search.omnimechs')}</option>
            </select>
          </label>
        </section>
      </aside>

      <section className="results">
        <div className="results-head">
          {progress ? (
            <span>{t('alpha.computing', { done: progress.done, total: progress.total || '…' })}</span>
          ) : (
            <>
              <strong>{t('search.hits', { count: total })}</strong>
              {total > rows.length && <span className="muted">{t('search.first', { count: rows.length })}</span>}
            </>
          )}
        </div>
        {progress && <progress className="alpha-progress" max={progress.total || 1} value={progress.done} />}
        {progress && <p className="hint">{t('alpha.computing-hint')}</p>}
        {error && <div className="banner error">{error}</div>}
        {!progress && (
          <div className="table-wrap">
            <table className="results-table">
              <thead>
                <tr>
                  <th>{t('search.col-mech')}</th><th className="num">t</th><th className="num">{t('stat.alpha')}</th>
                  <th className="num" title={t('alpha.heat-title')}>{t('alpha.heat')}</th><th className="num">{t('stat.speed')}</th>
                  <th>{t('weapons.title')}</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isOpen = open === r.variant;
                  return (
                    <Fragment key={r.variant}>
                      <tr className={`row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : r.variant)}>
                        <td>
                          <div className="mech-name">{r.label}{r.isOmni && <span className="tag">Omni</span>}</div>
                          <div className="mech-sub">
                            {r.faction === 'Clan' ? 'Clan' : 'Inner Sphere'}
                            {!r.proven && <span title={t('alpha.not-proven-hint')}> · {t('alpha.not-proven')}</span>}
                            {r.alsoVariants.length > 0 && ` · ${t(r.isOmni ? 'search.more-variants' : 'search.equal', { count: r.alsoVariants.length })}`}
                          </div>
                        </td>
                        <td className="num">{r.tons}</td>
                        <td className="num strong sorted">{fixed(r.alpha, 1)}</td>
                        <td className="num">{fixed(r.heat, 1)} / {fixed(r.capacity, 1)}{r.ghost > 0 && <div className="mech-sub">{t('alpha.ghost', { ghost: fixed(r.ghost, 1) })}</div>}</td>
                        <td className="num">{fixed(r.speed, 1)}</td>
                        <td className="small-text">{r.weapons.map((w) => <span key={w.name} className="weapon-chip"><span className={`dot hp-${w.hardpoint}`} />{w.count}× {w.label}</span>)}</td>
                        <td className="num"><button className="primary small" onClick={(e) => { e.stopPropagation(); openInLab(r); }}>{t('search.open-lab')}</button></td>
                      </tr>
                      {isOpen && (
                        <tr className="detail"><td colSpan={columns}>
                          <div className="detail-grid">
                            <div>
                              <h4>{t('alpha.code')}</h4>
                              {r.code ? <code className="code-text">{r.code}</code> : <p className="muted">{t('alpha.no-code')}</p>}
                            </div>
                            {r.alsoVariants.length > 0 && (
                              <div>
                                <h4>{t(r.isOmni ? 'search.other-variants' : 'search.equal-variants')}</h4>
                                <p className="muted">{r.alsoVariants.map((v) => v.toUpperCase()).join(', ')}</p>
                              </div>
                            )}
                            <div>
                              <h4>{t('alpha.share')}</h4>
                              <p>{num((r.heat / r.capacity) * 100, 1)} %</p>
                            </div>
                          </div>
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && <tr><td colSpan={columns} className="empty">{t('overview.empty')}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
