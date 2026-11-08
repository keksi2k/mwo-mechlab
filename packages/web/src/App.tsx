import { useEffect, useState } from 'react';
import { LOCALES, type Locale } from '@mwo/shared';
import { api, type Catalog } from './api.ts';
import { getLocale, setLocale, t } from './i18n.ts';
import { BuildsPage } from './BuildsPage.tsx';
import { MechlabPage } from './MechlabPage.tsx';
import { SearchPage } from './SearchPage.tsx';
import { WeaponsPage } from './WeaponsPage.tsx';

export interface Route { page: 'search' | 'weapons' | 'mechlab' | 'builds'; variant?: string; params: URLSearchParams }

function parseRoute(): Route {
  const [path = '', query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [page, variant] = path.split('/');
  const params = new URLSearchParams(query);
  if (page === 'mechlab') return { page: 'mechlab', variant: variant ? decodeURIComponent(variant) : undefined, params };
  if (page === 'builds') return { page: 'builds', params };
  // 'waffen' and 'suche' are the old German routes, kept for saved links
  if (page === 'weapons' || page === 'waffen') return { page: 'weapons', params };
  return { page: 'search', params };
}

export const go = (hash: string) => {
  location.hash = hash;
};

export function App() {
  const [route, setRoute] = useState(parseRoute);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocaleState] = useState<Locale>(getLocale());
  const changeLocale = (l: Locale) => {
    setLocale(l);
    setLocaleState(l);
  };

  useEffect(() => {
    const on = () => setRoute(parseRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    api.catalog().then(setCatalog).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">MWO<span>Mechlab</span></div>
        <nav>
          <a className={route.page === 'search' ? 'active' : ''} href="#/search">{t('nav.search')}</a>
          <a className={route.page === 'weapons' ? 'active' : ''} href="#/weapons">{t('nav.weapons')}</a>
          <a className={route.page === 'mechlab' ? 'active' : ''} href="#/mechlab">{t('nav.mechlab')}</a>
          <a className={route.page === 'builds' ? 'active' : ''} href="#/builds">{t('nav.builds')}</a>
        </nav>
        {catalog && <div className="build-info" title={t('app.extracted', { date: new Date(catalog.meta.extractedAt).toLocaleString(locale) })}>{t('app.gamedata', { version: catalog.meta.buildVersion })}</div>}
        <div className="lang" role="group" aria-label={t('app.language')}>
          {LOCALES.map((l) => <button key={l} className={l === locale ? 'on' : ''} aria-pressed={l === locale} onClick={() => changeLocale(l)}>{l.toUpperCase()}</button>)}
        </div>
      </header>
      <main>
        {error && <div className="banner error">{t('app.no-server', { error })}</div>}
        {!catalog && !error && <div className="empty">{t('app.loading')}</div>}
        {catalog && route.page === 'search' && <SearchPage catalog={catalog} />}
        {catalog && route.page === 'weapons' && <WeaponsPage catalog={catalog} />}
        {catalog && route.page === 'mechlab' && <MechlabPage key={`${route.variant ?? ''}?${route.params}`} catalog={catalog} route={route} />}
        {catalog && route.page === 'builds' && <BuildsPage catalog={catalog} />}
      </main>
    </div>
  );
}
