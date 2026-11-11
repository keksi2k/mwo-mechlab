import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dataset } from '@mwo/shared';

export const ROOT = join(import.meta.dirname, '..', '..', '..');
export const DATA = join(ROOT, 'data');

/** All extracted game data directories, oldest first */
export function buildDirs(): string[] {
  return readdirSync(DATA).filter((d) => /^build-\d+$/.test(d)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
}

export function latestDir(): string {
  const latest = buildDirs().at(-1);
  if (!latest) throw new Error('No game data found. Run `npm run extract` first.');
  return latest;
}

export function loadDataset(dir: string): Dataset {
  const read = (n: string) => JSON.parse(readFileSync(join(DATA, dir, `${n}.json`), 'utf8'));
  return {
    meta: read('meta'), items: read('items'), upgrades: read('upgrades'), mechs: read('mechs'),
    chassis: read('chassis'), loadouts: read('loadouts'), skills: read('skills'),
  };
}
