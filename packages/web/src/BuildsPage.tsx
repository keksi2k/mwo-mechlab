import { useEffect, useState } from 'react';
import { analyze, formatIssue, type Analysis } from '@mwo/shared';
import { api, type Catalog, type SavedBuild } from './api.ts';
import { go } from './App.tsx';
import { fixed, getLocale, t, type UiKey } from './i18n.ts';
import { buildCatalogIndex } from './MechlabPage.tsx';

interface Row { saved: SavedBuild; analysis: Analysis | null }

const METRICS: { label: UiKey; get: (a: Analysis) => number; digits: number; lower?: boolean }[] = [
  { label: 'stat.alpha', get: (a) => a.alpha, digits: 1 },
  { label: 'stat.dps', get: (a) => a.dps, digits: 2 },
  { label: 'stat.dps-double', get: (a) => a.dpsDoubleShot, digits: 2 },
  { label: 'stat.hps', get: (a) => a.hps, digits: 2, lower: true },
  { label: 'stat.alpha-heat', get: (a) => a.heat.alphaTotal, digits: 1, lower: true },
  { label: 'stat.heat-peak', get: (a) => a.heat.peakShare * 100, digits: 1, lower: true },
  { label: 'stat.alphas', get: (a) => a.heat.alphasToOverheat, digits: 0 },
  { label: 'stat.cooling', get: (a) => a.cooling, digits: 2 },
  { label: 'stat.capacity', get: (a) => a.heatCapacity, digits: 1 },
  { label: 'stat.speed', get: (a) => a.speed, digits: 1 },
  { label: 'stat.armor', get: (a) => a.armorPoints, digits: 0 },
  { label: 'stat.weight', get: (a) => a.tonsUsed, digits: 2 },
];

export function BuildsPage({ catalog }: { catalog: Catalog }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);

  const load = async () => {
    try {
      const saved = await api.builds();
      const out = await Promise.all(saved.map(async (s): Promise<Row> => {
        try {
          const d = await api.mech(s.variant);
          return { saved: s, analysis: analyze(s.build, buildCatalogIndex(catalog, d)) };
        } catch {
          return { saved: s, analysis: null };
        }
      }));
      setRows(out);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (id: string) => {
    await api.deleteBuild(id);
    setCompare(compare.filter((c) => c !== id));
    await load();
  };
  const toggle = (id: string) => setCompare(compare.includes(id) ? compare.filter((c) => c !== id) : [...compare, id]);

  if (error) return <div className="banner error">{error}</div>;
  if (!rows) return <div className="empty">{t('builds.loading')}</div>;
  if (rows.length === 0) {
    return <div className="empty">{t('builds.empty')} <a href="#/search">{t('builds.empty-link')}</a> {t('builds.empty-end')}</div>;
  }
  const selected = compare.map((id) => rows.find((r) => r.saved.id === id)).filter((r): r is Row => !!r?.analysis);
  const label = (s: SavedBuild) => catalog.mechs.find((m) => m.variant === s.variant)?.label ?? s.variant.toUpperCase();

  return (
    <div className="builds">
      <div className="panel">
        <h2>{t('builds.title')}</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t('builds.compare')}</th><th>{t('builds.name')}</th><th>{t('builds.mech')}</th><th className="num">Alpha</th><th className="num">DPS</th><th className="num">km/h</th><th>{t('builds.status')}</th><th /></tr></thead>
            <tbody>
              {rows.map(({ saved: s, analysis: a }) => (
                <tr key={s.id}>
                  <td><input type="checkbox" aria-label={t('builds.compare-item', { name: s.name })} checked={compare.includes(s.id)} disabled={!a} onChange={() => toggle(s.id)} /></td>
                  <td><strong>{s.name}</strong></td>
                  <td>{label(s)}</td>
                  <td className="num">{a ? fixed(a.alpha, 1) : '–'}</td>
                  <td className="num">{a ? fixed(a.dps, 2) : '–'}</td>
                  <td className="num">{a ? fixed(a.speed, 1) : '–'}</td>
                  <td>
                    {!a ? <span className="bad">{t('builds.gone')}</span> : a.issues.length > 0 ? <span className="bad" title={a.issues.map((i) => formatIssue(i, getLocale())).join('\n')}>{t('builds.problems', { count: a.issues.length })}</span> : <span className="ok">{t('builds.valid')}</span>}
                    {s.gameBuild !== catalog.meta.buildNumber && <span className="muted">{t('builds.from-build', { build: s.gameBuild })}</span>}
                  </td>
                  <td className="num">
                    <button className="primary small" onClick={() => go(`#/mechlab/${s.variant}?build=${s.id}`)}>{t('builds.open')}</button>{' '}
                    <button className="small" onClick={() => void remove(s.id)}>{t('builds.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="panel">
          <h2>{t('builds.compare')}</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th />{selected.map((r) => <th key={r.saved.id} className="num">{r.saved.name}<div className="muted">{label(r.saved)}</div></th>)}</tr></thead>
              <tbody>
                {METRICS.map((m) => {
                  const values = selected.map((r) => m.get(r.analysis!));
                  const best = m.lower ? Math.min(...values) : Math.max(...values);
                  return (
                    <tr key={m.label}>
                      <td>{t(m.label)}</td>
                      {values.map((v, i) => <td key={i} className={`num ${selected.length > 1 && v === best ? 'strong' : ''}`}>{fixed(v, m.digits)}</td>)}
                    </tr>
                  );
                })}
                <tr>
                  <td>{t('weapons.title')}</td>
                  {selected.map((r) => (
                    <td key={r.saved.id} className="small-text">
                      {r.analysis!.weapons.map((w) => <div key={w.weapon.id}><span className={`dot hp-${w.weapon.hardpoint}`} />{w.count}× {w.weapon.label}</div>)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
