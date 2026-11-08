import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex, type Dataset } from '@mwo/shared';

/** Loads the most recently extracted data. Run `npm run extract` first. */
export function loadDataset(): Dataset {
  const root = join(import.meta.dirname, '..', 'data');
  const latest = readdirSync(root).filter((d) => d.startsWith('build-')).sort().at(-1);
  if (!latest) throw new Error('No data; run npm run extract first');
  const read = (n: string) => JSON.parse(readFileSync(join(root, latest, `${n}.json`), 'utf8'));
  return {
    meta: read('meta'), items: read('items'), upgrades: read('upgrades'), mechs: read('mechs'),
    chassis: read('chassis'), loadouts: read('loadouts'), skills: read('skills'),
  };
}

export const data = loadDataset();
export const ix = buildIndex(data);
