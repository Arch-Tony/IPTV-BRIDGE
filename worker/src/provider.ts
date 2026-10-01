// Unified, edge-cached provider layer (Xtream + M3U). Per-user: every cache key
// is namespaced by the config fingerprint so users never see each other's data.

import { configFingerprint } from './config';
import { cleanTitle, titleIdentity } from './cleaner';
import { edgeCached, TTL } from './edgecache';
import { parseM3UPlaylist } from './m3u';
import { RawStream, XtreamClient } from './xtream';
import { Genre, MediaKind, ProviderItem, UserConfig } from './types';

function xtKind(kind: MediaKind): 'live' | 'movie' | 'series' {
  return kind === 'channel' ? 'live' : kind;
}

function parseProviderTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Xtream normally uses Unix seconds, but tolerate millisecond timestamps.
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function selectedXtreamCategoryIds(config: UserConfig, kind: MediaKind): Set<string> | null {
  const selected = config.includedCategories?.map(String).filter(Boolean);
  if (!selected?.length) return null;

  const prefix = kind === 'channel' ? 'live_' : kind === 'movie' ? 'vod_' : 'series_';
  const ids = selected.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));

  // A configured category list means "only these categories". If none belong
  // to this media kind, return an empty set rather than silently widening scope.
  return new Set(ids);
}

function buildXtreamItems(
  raw: RawStream[],
  kind: MediaKind,
  catMap: Map<string, string>,
  client: XtreamClient
): ProviderItem[] {
  const xt = xtKind(kind);
  const out: ProviderItem[] = [];
  for (const s of raw) {
    const streamId = s.stream_id ?? s.series_id;
    if (streamId === undefined || streamId === null) continue;
    const title = s.name || s.title || 'Untitled Stream';
    const cleaned = cleanTitle(title);
    const ext = s.container_extension || 'mp4';
    const catId = String(s.category_id ?? '');
    const rawYear = s.year ?? s.releaseDate ?? s.release_date;

    let url = '';
    if (xt === 'live') url = client.liveUrl(streamId);
    else if (xt === 'movie') url = client.movieUrl(streamId, ext);

    out.push({
      id: `xt_${xt}_${streamId}`,
      streamId,
      title,
      cleanTitle: cleaned.cleanTitle,
      type: kind,
      category: s.category_name || catMap.get(catId) || 'Uncategorized',
      logo: (s.stream_icon || s.cover || s.movie_image) as string | undefined,
      url,
      year: cleaned.year || (rawYear ? parseInt(String(rawYear).substring(0, 4), 10) : undefined),
      containerExtension: ext,
      tmdbId: s.tmdb_id !== undefined && s.tmdb_id !== null && String(s.tmdb_id).trim()
        ? String(s.tmdb_id).trim()
        : s.tmdb !== undefined && s.tmdb !== null && String(s.tmdb).trim()
          ? String(s.tmdb).trim()
          : undefined,
      addedAt: parseProviderTimestamp(s.added),
      updatedAt: parseProviderTimestamp(s.last_modified)
    });
  }
  return out;
}

/** All provider items for a media kind, cached per-user at the edge. */
export async function getItems(config: UserConfig, kind: MediaKind, ctx: ExecutionContext): Promise<ProviderItem[]> {
  const fp = configFingerprint(config);

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    return edgeCached(ctx, `xt:items:${fp}:${kind}`, TTL.STREAMS, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      const xt = xtKind(kind);
      const [cats, raw] = await Promise.all([
        client.getCategories(xt).catch(() => []),
        client.getStreams(xt)
      ]);
      const catMap = new Map(cats.map((c) => [c.category_id, c.category_name]));
      const selected = selectedXtreamCategoryIds(config, kind);
      const filtered = selected
        ? raw.filter((stream) => selected.has(String(stream.category_id ?? '')))
        : raw;
      return buildXtreamItems(filtered, kind, catMap, client);
    });
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const parsed = await edgeCached(ctx, `m3u:parsed:${fp}`, TTL.PLAYLIST, () => parseM3UPlaylist(config.m3uUrl!));
    const selected = config.includedCategories?.length ? new Set(config.includedCategories.map(String)) : null;
    return parsed.items.filter(
      (item) =>
        item.type === kind &&
        (!selected ||
          selected.has(item.category) ||
          selected.has(item.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')))
    );
  }

  return [];
}

/** Category list for a media kind (manifest genre options), cached per-user. */
export async function getGenres(config: UserConfig, kind: MediaKind, ctx: ExecutionContext): Promise<Genre[]> {
  const fp = configFingerprint(config);

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    return edgeCached(ctx, `xt:genres:${fp}:${kind}`, TTL.CATEGORIES, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      const cats = await client.getCategories(xtKind(kind)).catch(() => []);
      const selected = selectedXtreamCategoryIds(config, kind);
      const visible = selected ? cats.filter((c) => selected.has(String(c.category_id))) : cats;
      return visible.map((c) => ({ id: c.category_id, name: c.category_name }));
    });
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const items = await getItems(config, kind, ctx);
    const map = new Map<string, string>();
    for (const it of items) {
      const id = it.category.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (!map.has(id)) map.set(id, it.category);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  return [];
}

/** Exact-identity index lookup (fast path for global stream matching). */
export async function getTitleMatches(
  config: UserConfig,
  kind: Exclude<MediaKind, 'channel'>,
  titles: string[],
  ctx: ExecutionContext
): Promise<ProviderItem[]> {
  const items = await getItems(config, kind, ctx);
  const index = new Map<string, ProviderItem[]>();
  for (const item of items) {
    const key = titleIdentity(item.title);
    if (!key) continue;
    const list = index.get(key) || [];
    list.push(item);
    index.set(key, list);
  }

  const matches: ProviderItem[] = [];
  const seen = new Set<string>();
  for (const title of titles) {
    for (const item of index.get(titleIdentity(title)) || []) {
      const identity = String(item.streamId ?? item.url ?? item.id);
      if (seen.has(identity)) continue;
      seen.add(identity);
      matches.push(item);
    }
  }
  return matches;
}
