import { useEffect, useState } from 'react';
import { formatQuirkValue, type DatasetDiff, type QuirkChange } from '@mwo/shared';
import { api, type PatchInfo } from './api.ts';
import { getLocale, t } from './i18n.ts';

const quirkValue = (c: QuirkChange, v: number | null) => (v === null ? '–' : formatQuirkValue({ kind: c.kind, value: v }, getLocale()));

export function PatchesPage() {
  const [patches, setPatches] = useState<PatchInfo[] | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [diff, setDiff] = useState<DatasetDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.patches().then((list) => {
      setPatches(list);
      if (list.length >= 2) {
        setFrom(list.at(-2)!.dir);
        setTo(list.at(-1)!.dir);
      }
    }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!from || !to) return;
    setDiff(null);
    api.patchDiff(from, to).then(setDiff).catch((e: Error) => setError(e.message));
  }, [from, to]);

  if (error) return <div className="banner error">{error}</div>;
  if (!patches) return <div className="empty">{t('app.loading')}</div>;
  if (patches.length < 2) {
    return (
      <div className="panel patches">
        <h2>{t('patch.title')}</h2>
        <p>{t('patch.only-one', { version: patches[0]?.buildVersion ?? '–' })}</p>
      </div>
    );
  }
  const option = (p: PatchInfo) => <option key={p.dir} value={p.dir}>{p.buildVersion} ({new Date(p.extractedAt).toLocaleDateString(getLocale())})</option>;
  const empty = diff && !diff.mechsAdded.length && !diff.mechsRemoved.length && !diff.quirks.length && !diff.items.length && !diff.itemsAdded.length && !diff.itemsRemoved.length;

  return (
    <div className="panel patches">
      <h2>{t('patch.title')}</h2>
      <div className="field-row">
        <label className="field">{t('patch.from')}<select value={from} onChange={(e) => setFrom(e.target.value)}>{patches.map(option)}</select></label>
        <label className="field">{t('patch.to')}<select value={to} onChange={(e) => setTo(e.target.value)}>{patches.map(option)}</select></label>
      </div>
      {!diff && <p className="muted">{t('app.loading')}</p>}
      {empty && <p className="muted">{t('patch.none')}</p>}
      {diff && (
        <>
          {(diff.mechsAdded.length > 0 || diff.mechsRemoved.length > 0) && (
            <section>
              <h3>{t('patch.mechs')}</h3>
              <ul>
                {diff.mechsAdded.map((m) => <li key={m.variant}><span className="ok">+</span> <a href={`#/mechlab/${m.variant}`}>{m.label}</a></li>)}
                {diff.mechsRemoved.map((m) => <li key={m.variant}><span className="bad">−</span> {m.label}</li>)}
              </ul>
            </section>
          )}
          {diff.quirks.length > 0 && (
            <section>
              <h3>{t('patch.quirks', { count: diff.quirks.length })}</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{t('patch.owner')}</th><th>{t('patch.quirk')}</th><th className="num">{t('patch.before')}</th><th className="num">{t('patch.after')}</th></tr></thead>
                  <tbody>
                    {diff.quirks.flatMap((o) => o.changes.map((c, i) => (
                      <tr key={`${o.owner}|${c.raw}`}>
                        <td>{i === 0 && (o.kind === 'mech' ? <a href={`#/mechlab/${o.owner}`}>{o.label}</a> : <>{o.label} <span className="muted">{t(o.kind === 'pod' ? 'patch.pod' : 'patch.set')}</span></>)}</td>
                        <td title={c.raw}>{c.label}</td>
                        <td className="num muted">{quirkValue(c, c.before)}</td>
                        <td className="num strong">{quirkValue(c, c.after)}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {(diff.items.length > 0 || diff.itemsAdded.length > 0 || diff.itemsRemoved.length > 0) && (
            <section>
              <h3>{t('patch.items')}</h3>
              <ul>
                {diff.itemsAdded.map((i) => <li key={i.name}><span className="ok">+</span> {i.label}</li>)}
                {diff.itemsRemoved.map((i) => <li key={i.name}><span className="bad">−</span> {i.label}</li>)}
              </ul>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{t('patch.item')}</th><th>{t('patch.value')}</th><th className="num">{t('patch.before')}</th><th className="num">{t('patch.after')}</th></tr></thead>
                  <tbody>
                    {diff.items.flatMap((it) => it.changes.map((c, i) => (
                      <tr key={`${it.name}|${c.key}`}>
                        <td>{i === 0 && it.label}</td><td><code>{c.key}</code></td>
                        <td className="num muted">{c.before ?? '–'}</td><td className="num strong">{c.after ?? '–'}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
