// Computes the best alpha strike for one mech at a time; the pool in alpha-pool.ts hands out the mechs.
import { parentPort, workerData } from 'node:worker_threads';
import { alphaRow, bestAlpha, buildIndex, type AlphaOptions } from '@mwo/shared';
import { loadDataset } from './data.ts';

const { dir, options } = workerData as { dir: string; options: AlphaOptions };
const ix = buildIndex(loadDataset(dir));

parentPort!.on('message', (m: { variant?: unknown }) => {
  if (typeof m?.variant !== 'string') return;
  const mech = ix.mechs.get(m.variant);
  const r = mech ? bestAlpha(mech, ix, options) : null;
  parentPort!.postMessage({ type: 'row', variant: m.variant, row: mech && r ? alphaRow(mech, r, ix) : null });
});
