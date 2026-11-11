import type {
  AlphaQuery, AlphaResult, Build, DatasetDiff, Chassis, Faction, Item, Loadout, Mech, Meta, QuirkCatalogEntry, SearchPreset, SearchQuery, SearchResult, SkillNode, Upgrade, WeaponQuery, WeaponResult,
} from '@mwo/shared';
import { t, UI_TEXTS, type UiKey } from './i18n.ts';

export interface Catalog {
  meta: Meta;
  items: Item[];
  upgrades: Upgrade[];
  skills: SkillNode[];
  quirks: QuirkCatalogEntry[];
  weaponStats: string[];
  presets: SearchPreset[];
  mechs: { id: number; variant: string; label: string; chassis: string; tons: number; faction: Faction }[];
}
export interface MechDetail { mech: Mech; loadout: Loadout; chassis: Chassis | null }
export interface PatchInfo { dir: string; buildNumber: string; buildVersion: string; extractedAt: string }
export interface SavedBuild { id: string; name: string; variant: string; build: Build; gameBuild: string; createdAt: string; updatedAt: string }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const key = `error.${body?.error}` as UiKey;
    throw new Error(body?.error && key in UI_TEXTS.en ? t(key) : t('error.status', { status: String(res.status) }));
  }
  return (await res.json()) as T;
}
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export const api = {
  catalog: () => request<Catalog>('/api/catalog'),
  mech: (variant: string) => request<MechDetail>(`/api/mechs/${encodeURIComponent(variant)}`),
  search: (q: SearchQuery) => request<SearchResult & { ms: number }>('/api/search', json('POST', q)),
  weapons: (q: WeaponQuery) => request<WeaponResult & { ms: number }>('/api/weapons', json('POST', q)),
  alpha: (q: AlphaQuery) => request<({ status: 'ready' } & AlphaResult) | { status: 'running'; done: number; total: number }>('/api/alpha', json('POST', q)),
  patches: () => request<PatchInfo[]>('/api/patches'),
  patchDiff: (from: string, to: string) => request<DatasetDiff>(`/api/patches/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  builds: () => request<SavedBuild[]>('/api/builds'),
  createBuild: (name: string, build: Build) => request<SavedBuild>('/api/builds', json('POST', { name, build })),
  updateBuild: (id: string, name: string, build: Build) => request<SavedBuild>(`/api/builds/${id}`, json('PUT', { name, build })),
  deleteBuild: (id: string) => request<{ ok: boolean }>(`/api/builds/${id}`, { method: 'DELETE' }),
};
