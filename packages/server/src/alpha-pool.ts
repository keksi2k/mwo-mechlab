import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { AlphaOptions, AlphaRow, GameIndex } from '@mwo/shared';

/**
 * Computes the alpha ranking on several worker threads. The mechs are independent, so each worker takes the next
 * mech as soon as it is free; slow mechs then do not hold up the others. One core stays free for the API and the UI.
 */
export const ALPHA_THREADS = Math.max(1, Math.min(Number(process.env['MWO_ALPHA_THREADS']) || availableParallelism() - 1, 32));

export interface AlphaRun {
  /** Stops all workers; the callbacks are not called afterwards */
  stop: () => void;
}

export function runAlpha(
  dir: string, options: AlphaOptions, ix: GameIndex, only: string[] | undefined,
  on: { progress: (done: number, total: number) => void; done: (rows: AlphaRow[]) => void; error: (e: Error) => void },
): AlphaRun {
  // Heavy mechs first: they take longest, and starting them early keeps all workers busy until the end
  const queue = [...ix.mechs.values()].filter((m) => !m.special && (!only?.length || only.includes(m.variant)))
    .sort((a, b) => b.tons - a.tons || a.variant.localeCompare(b.variant)).map((m) => m.variant);
  const total = queue.length;
  const rows: AlphaRow[] = [];
  let done = 0;
  let stopped = false;
  const workers: Worker[] = [];
  const stop = () => {
    stopped = true;
    for (const w of workers) void w.terminate();
  };
  on.progress(0, total);
  if (total === 0) {
    on.done([]);
    return { stop };
  }

  const next = (w: Worker) => {
    const variant = queue.shift();
    if (variant !== undefined) w.postMessage({ variant });
  };
  for (let i = 0; i < Math.min(ALPHA_THREADS, total); i++) {
    const w = new Worker(new URL('./alpha-worker.ts', import.meta.url), { workerData: { dir, options } });
    workers.push(w);
    // Under `node --watch` workers also send Node's own messages (the files they load), so only rows count.
    w.on('message', (m: { type?: unknown; row?: AlphaRow | null } | null) => {
      if (stopped || !m || m.type !== 'row') return;
      if (m.row) rows.push(m.row);
      done++;
      if (done === total) {
        stop();
        on.done(rows);
        return;
      }
      if (done % 10 === 0) on.progress(done, total);
      next(w);
    });
    w.on('error', (e: Error) => {
      if (stopped) return;
      stop();
      on.error(e);
    });
    next(w);
  }
  return { stop };
}
