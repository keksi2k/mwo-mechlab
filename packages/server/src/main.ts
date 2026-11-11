import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import {
  alphaOptionsKey, buildIndex, diffDatasets, HARDPOINT_TYPES, quirkCatalog, rankAlphaRows, searchMechs, SEARCH_PRESETS, WEAPON_QUIRK_STATS, WEAPON_STAT_KEYS, weaponOverview,
  type AlphaOptions, type AlphaQuery, type AlphaRow, type Dataset, type SearchQuery, type WeaponQuery,
} from '@mwo/shared';
import { ALPHA_THREADS, runAlpha, type AlphaRun } from './alpha-pool.ts';
import { buildDirs, DATA, latestDir, loadDataset } from './data.ts';

const PORT = Number(process.env['PORT'] ?? 4680);

function prepare(data: Dataset) {
  return {
    data,
    ix: buildIndex(data),
    catalog: {
      meta: data.meta,
      items: data.items,
      upgrades: data.upgrades,
      skills: data.skills,
      quirks: quirkCatalog(data),
      weaponStats: WEAPON_QUIRK_STATS,
      presets: SEARCH_PRESETS,
      mechs: data.mechs.filter((m) => !m.special).map((m) => ({ id: m.id, variant: m.variant, label: m.label, chassis: m.chassis, tons: m.tons, faction: m.faction })),
    },
  };
}

const metaStamp = (dir: string) => `${dir}:${statSync(join(DATA, dir, 'meta.json')).mtimeMs}`;
let loadedDir = latestDir();
let loadedStamp = metaStamp(loadedDir);
let game = prepare(loadDataset(loadedDir));

/** Reloads when `npm run extract` has written new data, so a running server stays up to date. */
function current() {
  try {
    const dir = latestDir();
    const stamp = metaStamp(dir);
    if (stamp !== loadedStamp) {
      game = prepare(loadDataset(dir));
      loadedDir = dir;
      loadedStamp = stamp;
      console.log(`Game data reloaded: build ${game.data.meta.buildVersion}`);
    }
  } catch (e) {
    console.error(`Could not reload the game data, keeping the old data: ${(e as Error).message}`);
  }
  return game;
}

// Saved builds are kept apart from the game data and survive a patch.
const db = new DatabaseSync(process.env['MWO_USER_DB'] ?? join(DATA, 'user.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS builds(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, variant TEXT NOT NULL, build TEXT NOT NULL,
  game_build TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);

interface BuildRow { id: string; name: string; variant: string; build: string; game_build: string; created_at: string; updated_at: string }
const rowToBuild = (r: BuildRow) => ({
  id: r.id, name: r.name, variant: r.variant, build: JSON.parse(r.build), gameBuild: r.game_build, createdAt: r.created_at, updatedAt: r.updated_at,
});

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

app.get('/api/catalog', async () => current().catalog);

app.get<{ Params: { variant: string } }>('/api/mechs/:variant', async (req, reply) => {
  const { ix } = current();
  const mech = ix.mechs.get(req.params.variant.toLowerCase());
  if (!mech) return reply.code(404).send({ error: 'unknown-mech' });
  return { mech, loadout: ix.loadouts.get(mech.variant), chassis: ix.chassis.get(mech.chassis) ?? null };
});

app.post<{ Body: SearchQuery }>('/api/search', async (req, reply) => {
  const q = req.body;
  if (!q || typeof q !== 'object' || !Array.isArray(q.criteria) || typeof q.filters !== 'object') {
    return reply.code(400).send({ error: 'invalid-search' });
  }
  const started = performance.now();
  const result = searchMechs({ ...q, limit: Math.min(q.limit ?? 200, 2000) }, current().ix);
  return { ...result, ms: Math.round(performance.now() - started) };
});

app.post<{ Body: WeaponQuery }>('/api/weapons', async (req, reply) => {
  const q = req.body;
  if (!q || !Array.isArray(q.weapons) || q.weapons.length === 0 || !WEAPON_STAT_KEYS.includes(q.sortBy) || typeof q.filters !== 'object') {
    return reply.code(400).send({ error: 'invalid-search' });
  }
  const started = performance.now();
  const result = weaponOverview({ ...q, limit: Math.min(q.limit ?? 200, 2000) }, current().ix);
  return { ...result, ms: Math.round(performance.now() - started) };
});

// Best alpha strike per mech: slow, so it runs once per game data and options on worker threads and is cached on disk.
type AlphaJob = { rows: AlphaRow[] } | { done: number; total: number; error?: string };
const alphaJobs = new Map<string, AlphaJob>();
/** Only one calculation at a time: a new request for other options stops the running one */
let runningAlpha: { id: string; run: AlphaRun } | null = null;

function validAlphaOptions(o: unknown): o is AlphaOptions {
  const x = o as AlphaOptions | null;
  if (!x || typeof x !== 'object') return false;
  if (x.hardpointTypes !== undefined && (!Array.isArray(x.hardpointTypes) || !x.hardpointTypes.every((t) => HARDPOINT_TYPES.includes(t) && t !== 'ams'))) return false;
  for (const n of [x.minRange, x.minSpeed]) if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 5000)) return false;
  return x.mixGhostGroups === undefined || typeof x.mixGhostGroups === 'boolean';
}

function alphaJob(options: AlphaOptions): AlphaJob {
  const key = alphaOptionsKey(options);
  const dir = loadedDir;
  const id = `${dir}|${key}`;
  const known = alphaJobs.get(id);
  if (known && !('error' in known && known.error)) return known;
  // MWO_ALPHA_CACHE and MWO_ALPHA_ONLY (comma-separated variants) let the browser test run quickly without touching data/
  const cacheDir = process.env['MWO_ALPHA_CACHE'] ? join(process.env['MWO_ALPHA_CACHE'], dir) : join(DATA, dir, 'alpha');
  const only = process.env['MWO_ALPHA_ONLY']?.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  const file = join(cacheDir, `${createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`);
  if (existsSync(file)) {
    const job = { rows: JSON.parse(readFileSync(file, 'utf8')) as AlphaRow[] };
    alphaJobs.set(id, job);
    return job;
  }
  if (runningAlpha) {
    runningAlpha.run.stop();
    alphaJobs.delete(runningAlpha.id);
  }
  const job: AlphaJob = { done: 0, total: 0 };
  alphaJobs.set(id, job);
  const started = performance.now();
  const run = runAlpha(dir, options, current().ix, only, {
    progress: (done, total) => alphaJobs.set(id, { done, total }),
    done: (rows) => {
      runningAlpha = null;
      alphaJobs.set(id, { rows });
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(file, JSON.stringify(rows));
      } catch (e) {
        console.error(`Could not store the alpha ranking, it is kept in memory only: ${(e as Error).message}`);
      }
      console.log(`Alpha ranking computed for ${dir} in ${Math.round((performance.now() - started) / 1000)} s on ${ALPHA_THREADS} threads`);
    },
    error: (e) => {
      runningAlpha = null;
      console.error(`Alpha ranking failed: ${e.message}`);
      alphaJobs.set(id, { done: 0, total: 0, error: e.message });
    },
  });
  runningAlpha = { id, run };
  return job;
}

app.post<{ Body: AlphaQuery }>('/api/alpha', async (req, reply) => {
  const q = req.body;
  if (!q || typeof q.filters !== 'object' || !validAlphaOptions(q.options)) return reply.code(400).send({ error: 'invalid-search' });
  const { ix } = current();
  const job = alphaJob(q.options);
  if ('rows' in job) return { status: 'ready', ...rankAlphaRows(job.rows, { filters: q.filters, limit: Math.min(q.limit ?? 200, 2000) }, ix) };
  if (job.error) return reply.code(500).send({ error: 'alpha-failed' });
  return { status: 'running', done: job.done, total: job.total };
});

// Patch changes: every extracted game version stays in its own folder.
app.get('/api/patches', async () => buildDirs().map((dir) => {
  const meta = JSON.parse(readFileSync(join(DATA, dir, 'meta.json'), 'utf8')) as Dataset['meta'];
  return { dir, buildNumber: meta.buildNumber, buildVersion: meta.buildVersion, extractedAt: meta.extractedAt };
}));

app.get<{ Querystring: { from?: string; to?: string } }>('/api/patches/diff', async (req, reply) => {
  const dirs = buildDirs();
  const { from, to } = req.query;
  if (!from || !to || !dirs.includes(from) || !dirs.includes(to)) return reply.code(400).send({ error: 'unknown-patch' });
  const load = (dir: string) => (dir === loadedDir ? current().data : loadDataset(dir));
  return diffDatasets(load(from), load(to));
});

app.get('/api/builds', async () => (db.prepare('SELECT * FROM builds ORDER BY updated_at DESC').all() as unknown as BuildRow[]).map(rowToBuild));

function validBuildBody(b: unknown): b is { name: string; build: { variant: string } } {
  const x = b as { name?: unknown; build?: { variant?: unknown } } | null;
  return !!x && typeof x.name === 'string' && x.name.trim().length > 0 && typeof x.build?.variant === 'string' && current().ix.mechs.has(x.build.variant);
}

app.post('/api/builds', async (req, reply) => {
  if (!validBuildBody(req.body)) return reply.code(400).send({ error: 'invalid-build' });
  const now = new Date().toISOString();
  const id = randomUUID();
  const { name, build } = req.body;
  db.prepare('INSERT INTO builds VALUES (?,?,?,?,?,?,?)').run(id, name.trim(), build.variant, JSON.stringify(build), current().data.meta.buildNumber, now, now);
  return rowToBuild(db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as unknown as BuildRow);
});

app.put<{ Params: { id: string } }>('/api/builds/:id', async (req, reply) => {
  if (!validBuildBody(req.body)) return reply.code(400).send({ error: 'invalid-build' });
  const { name, build } = req.body;
  const res = db.prepare('UPDATE builds SET name = ?, variant = ?, build = ?, game_build = ?, updated_at = ? WHERE id = ?')
    .run(name.trim(), build.variant, JSON.stringify(build), current().data.meta.buildNumber, new Date().toISOString(), req.params.id);
  if (res.changes === 0) return reply.code(404).send({ error: 'build-not-found' });
  return rowToBuild(db.prepare('SELECT * FROM builds WHERE id = ?').get(req.params.id) as unknown as BuildRow);
});

app.delete<{ Params: { id: string } }>('/api/builds/:id', async (req, reply) => {
  const res = db.prepare('DELETE FROM builds WHERE id = ?').run(req.params.id);
  if (res.changes === 0) return reply.code(404).send({ error: 'build-not-found' });
  return { ok: true };
});

// Only reachable locally
await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`API running at http://127.0.0.1:${PORT} (game data build ${game.data.meta.buildVersion})`);
