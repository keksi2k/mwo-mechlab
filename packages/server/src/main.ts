import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import {
  buildIndex, quirkCatalog, searchMechs, SEARCH_PRESETS, WEAPON_QUIRK_STATS, WEAPON_STAT_KEYS, weaponOverview,
  type Dataset, type SearchQuery, type WeaponQuery,
} from '@mwo/shared';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const DATA = join(ROOT, 'data');
const PORT = Number(process.env['PORT'] ?? 4680);

function latestDir(): string {
  const dirs = readdirSync(DATA).filter((d) => /^build-\d+$/.test(d)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const latest = dirs.at(-1);
  if (!latest) throw new Error('No game data found. Run `npm run extract` first.');
  return latest;
}

function loadDataset(latest: string): Dataset {
  const read = (n: string) => JSON.parse(readFileSync(join(DATA, latest, `${n}.json`), 'utf8'));
  return {
    meta: read('meta'), items: read('items'), upgrades: read('upgrades'), mechs: read('mechs'),
    chassis: read('chassis'), loadouts: read('loadouts'), skills: read('skills'),
  };
}

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
