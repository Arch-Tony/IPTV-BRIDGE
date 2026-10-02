// Stremio/Nuvio addon protocol handlers (per-user config). Ported from the Node
// addon: provider data is edge-cached per user, TMDB is edge-cached globally.

import { configFingerprint, validateConfig } from './config';
import { cleanTitle, titleIdentity } from './cleaner';
import { decodeItemId, encodeItemId, isItemId } from './id';
import { getItems, getTitleMatches } from './provider';
import { itemsToStreams, rankMatches } from './matcher';
import { TMDBClient } from './tmdb';
import { XtreamClient } from './xtream';
import { CACHE, json } from './responses';
import { edgeGet, edgePut, TTL } from './edgecache';
import { isSafeProtocolId } from './security';
import { Env, MediaKind, StremioMeta, StremioStream, UserConfig } from './types';

function typeToKind(type: string): MediaKind {
  if (type === 'tv') return 'channel';
  if (type === 'movie') return 'movie';
  return 'series';
}

function tmdbFor(config: UserConfig, env: Env, ctx: ExecutionContext): TMDBClient {
  return new TMDBClient(config.tmdbApiKey || env.TMDB_FALLBACK_KEY, ctx);
}

const CATALOG_PAGE_SIZE = 20;

interface CatalogSourceRef {
  streamId: string | number;
  title: string;
  containerExtension?: string;
  category?: string;
  tmdbId?: string;
}

function catalogSourceKey(config: UserConfig, kind: 'movie' | 'series', externalId: string): string {
  return `catalog-source:${configFingerprint(config)}:${kind}:${externalId}`;
}

function rememberCatalogSources(
  config: UserConfig,
  kind: 'movie' | 'series',
  externalId: string,
  refs: CatalogSourceRef[],
  ctx: ExecutionContext
): void {
  if (!refs.length) return;
  edgePut(ctx, catalogSourceKey(config, kind, externalId), refs, TTL.CATALOG_MAP);
}

async function getRememberedCatalogSources(
  config: UserConfig,
  kind: 'movie' | 'series',
  externalId: string
): Promise<CatalogSourceRef[]> {
  return (await edgeGet<CatalogSourceRef[]>(catalogSourceKey(config, kind, externalId))) || [];
}

async function resolveCatalogImdbId(
  item: Awaited<ReturnType<typeof getItems>>[number],
  kind: 'movie' | 'series',
  tmdb: TMDBClient
): Promise<string | undefined> {
  const clean = cleanTitle(item.title).cleanTitle || item.title;

  let full: any | null = null;
  if (item.tmdbId && /^\d+$/.test(item.tmdbId)) {
    full = await tmdb.getByTmdbId(item.tmdbId, kind);
  } else {
    const found = await tmdb.bestSearchMatch(clean, kind, item.year);
    if (!found?.id) return undefined;

    const sourceIdentity = titleIdentity(clean);
    const candidateTitles =
      kind === 'movie'
        ? [found.title, found.original_title]
        : [found.name, found.original_name];
    const titleMatches = candidateTitles
      .filter(Boolean)
      .some((title: unknown) => titleIdentity(String(title)) === sourceIdentity);

    const releaseDate = kind === 'movie' ? found.release_date : found.first_air_date;
    const resultYear = releaseDate ? parseInt(String(releaseDate).slice(0, 4), 10) : undefined;
    if (item.year && resultYear) {
      if (Math.abs(resultYear - item.year) > 1) return undefined;
    } else if (!titleMatches) {
      return undefined;
    }

    full = await tmdb.getByTmdbId(found.id, kind);
  }

  const imdbId = full?.external_ids?.imdb_id;
  return typeof imdbId === 'string' && /^tt\d+$/.test(imdbId) ? imdbId : undefined;
}

export interface CatalogParams {
  type: string;
  extra: string;
  search: URLSearchParams;
}

function readExtra(p: CatalogParams): { genre?: string; skip: number; search?: string } {
  let genre = p.search.get('genre') || undefined;
  let search = p.search.get('search') || undefined;
  let skip = parseInt(p.search.get('skip') || '0', 10) || 0;
  if (p.extra) {
    for (const kv of p.extra.split('&')) {
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const key = kv.slice(0, eq);
      const val = decodeURIComponent(kv.slice(eq + 1));
      if (key === 'genre') genre = val;
      else if (key === 'search') search = val;
      else if (key === 'skip') skip = parseInt(val, 10) || 0;
    }
  }
  return { genre, skip, search };
}

/* --------------------------------- CATALOG -------------------------------- */

export async function handleCatalog(
  env: Env,
  config: UserConfig,
  params: CatalogParams,
  baseUrl: string,
  ctx: ExecutionContext
): Promise<Response> {
  if (validateConfig(config)) return json({ metas: [] }, { cache: CACHE.catalog });

  const kind = typeToKind(params.type);
  const { genre, skip, search } = readExtra(params);
  const fallbackPoster = `${baseUrl}/logo.png`;

  let items = await getItems(config, kind, ctx);
  if (genre) items = items.filter((i) => i.category === genre);

  // Sipario home rows should surface the provider's newest additions first.
  // Movies generally expose `added`; series commonly expose `last_modified`
  // when a new episode arrives, with `added` as a fallback.
  if (kind === 'movie' || kind === 'series') {
    const recentTs = (item: (typeof items)[number]): number =>
      kind === 'series' ? item.updatedAt ?? item.addedAt ?? 0 : item.addedAt ?? item.updatedAt ?? 0;
    items = [...items].sort((a, b) => recentTs(b) - recentTs(a));
  }
  if (search) {
    const q = search.toLowerCase();
    items = items.filter((i) => i.title.toLowerCase().includes(q) || i.cleanTitle.toLowerCase().includes(q));
  }

  // Keep each catalog page below the Worker/TMDb subrequest budget. Sipario can
  // request further pages through `skip`, while the home row stays fast.
  const page = items.slice(skip, skip + CATALOG_PAGE_SIZE);
  let catalogIds: Array<string | undefined> = page.map(() => undefined);
  if (kind === 'movie' || kind === 'series') {
    const tmdb = tmdbFor(config, env, ctx);
    catalogIds = await Promise.all(page.map((item) => resolveCatalogImdbId(item, kind, tmdb)));
  }

  // Keep the exact Xtream source behind each IMDb card from our own catalog.
  // This allows the stream endpoint to answer immediately when the user opens
  // one of our "Nouveautés" cards, without repeating TMDb + title matching.
  if (kind === 'movie' || kind === 'series') {
    const grouped = new Map<string, CatalogSourceRef[]>();
    page.forEach((item, index) => {
      const externalId = catalogIds[index];
      if (!externalId || !externalId.startsWith('tt') || item.streamId === undefined) return;
      const list = grouped.get(externalId) || [];
      list.push({
        streamId: item.streamId,
        title: item.title,
        containerExtension: item.containerExtension,
        category: item.category,
        tmdbId: item.tmdbId
      });
      grouped.set(externalId, list);
    });
    for (const [externalId, refs] of grouped) {
      rememberCatalogSources(config, kind, externalId, refs, ctx);
    }
  }

  const metas = page.map((item, index) => ({
    // Cinemeta-compatible IMDb ids let Sipario route the card through its
    // normal rich movie/series detail flow. If matching is uncertain, retain
    // the IPTV id rather than risk opening the wrong title.
    id: catalogIds[index] || encodeItemId(item),
    type: params.type,
    name: cleanTitle(item.title).cleanTitle || item.title,
    poster: item.logo || fallbackPoster,
    posterShape: kind === 'channel' ? 'square' : 'poster',
    description: `Category: ${item.category}`,
    year: item.year
  }));

  return json({ metas }, { cache: CACHE.catalog });
}

/* ---------------------------------- META ---------------------------------- */

export async function handleMeta(
  env: Env,
  config: UserConfig,
  type: string,
  id: string,
  baseUrl: string,
  ctx: ExecutionContext
): Promise<Response> {
  if (!isSafeProtocolId(id) || validateConfig(config)) return json({ meta: null }, { cache: CACHE.meta });
  const fallbackPoster = `${baseUrl}/logo.png`;
  const tmdb = tmdbFor(config, env, ctx);

  // Catalog cards may use TMDb ids. Serve full metadata for those ids so
  // Sipario can render a real detail page instead of only resolving streams.
  if (id.startsWith('tmdb:')) {
    const tmdbId = id.split(':')[1];
    if (!/^\d+$/.test(tmdbId || '')) return json({ meta: null }, { cache: CACHE.meta });

    const tmdbType = type === 'series' ? 'series' : 'movie';
    const metaId = `tmdb:${tmdbId}`;
    const full = await tmdb.getByTmdbId(tmdbId, tmdbType);
    if (!full) return json({ meta: null }, { cache: CACHE.meta });

    const meta = tmdb.formatToStremioMeta(full, tmdbType, metaId);
    if (tmdbType === 'series') {
      const seasons: number[] = (full.seasons || [])
        .map((s: any) => s.season_number)
        .filter((n: number) => n && n > 0);
      const videos: NonNullable<StremioMeta['videos']> = [];
      for (const sNum of seasons.slice(0, 20)) {
        const eps = await tmdb.getSeasonEpisodes(full.id, sNum);
        for (const ep of eps) {
          videos.push({
            id: `${metaId}:${sNum}:${ep.episode_number}`,
            title: ep.name || `Episode ${ep.episode_number}`,
            season: sNum,
            episode: ep.episode_number,
            released: ep.air_date ? `${ep.air_date}T00:00:00.000Z` : undefined,
            thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : undefined,
            overview: ep.overview
          });
        }
      }
      meta.videos = videos;
    }
    return json({ meta }, { cache: CACHE.meta });
  }

  if (!isItemId(id)) return json({ meta: null }, { cache: CACHE.meta });
  const { ref } = decodeItemId(id);
  if (!ref) return json({ meta: null }, { cache: CACHE.meta });

  const clean = cleanTitle(ref.t).cleanTitle || ref.t;

  if (ref.k !== 'channel') {
    const tmdbType = ref.k === 'movie' ? 'movie' : 'series';
    const found = await tmdb.bestSearchMatch(clean, tmdbType, ref.y);
    if (found) {
      const full = await tmdb.getByTmdbId(found.id, tmdbType);
      const base = tmdb.formatToStremioMeta(full || found, tmdbType, id);

      if (ref.k === 'series' && config.type === 'xtream' && ref.sid !== undefined) {
        try {
          const client = new XtreamClient(config.host!, config.username!, config.password!);
          const episodes = await client.listAllEpisodes(ref.sid);
          base.videos = episodes.map((ep) => ({
            id: `${id}:${ep.season}:${ep.episode}`,
            title: ep.title,
            season: ep.season,
            episode: ep.episode,
            released: ep.released,
            overview: ep.overview,
            thumbnail: ep.thumbnail
          }));
        } catch {
          /* leave videos undefined on upstream failure */
        }
      } else if (ref.k === 'series' && full) {
        const seasons: number[] = (full.seasons || [])
          .map((s: any) => s.season_number)
          .filter((n: number) => n && n > 0);
        const videos: NonNullable<StremioMeta['videos']> = [];
        for (const sNum of seasons.slice(0, 30)) {
          const eps = await tmdb.getSeasonEpisodes(full.id, sNum);
          for (const ep of eps) {
            videos.push({
              id: `${id}:${sNum}:${ep.episode_number}`,
              title: ep.name || `Episode ${ep.episode_number}`,
              season: sNum,
              episode: ep.episode_number,
              released: ep.air_date ? `${ep.air_date}T00:00:00.000Z` : undefined,
              thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : undefined,
              overview: ep.overview
            });
          }
        }
        base.videos = videos;
      }

      return json({ meta: base }, { cache: CACHE.meta });
    }
  }

  // Fallback: plain meta from the provider item itself.
  const meta: StremioMeta = {
    id,
    type,
    name: clean,
    poster: ref.lg || fallbackPoster,
    posterShape: ref.k === 'channel' ? 'square' : 'poster',
    background: ref.lg,
    description: ref.k === 'channel' ? 'Live IPTV channel' : 'IPTV title',
    year: ref.y
  };
  return json({ meta }, { cache: CACHE.meta });
}

/* --------------------------------- STREAM --------------------------------- */

export async function handleStream(
  env: Env,
  config: UserConfig,
  type: string,
  id: string,
  ctx: ExecutionContext
): Promise<Response> {
  if (!isSafeProtocolId(id) || validateConfig(config)) return json({ streams: [] }, { cache: CACHE.stream });

  if (isItemId(id)) {
    const streams = await resolveOwnItemStreams(config, id);
    return json({ streams }, { cache: CACHE.stream });
  }
  const streams = await resolveGlobalStreams(env, config, id, type, ctx);
  return json({ streams }, { cache: CACHE.stream });
}

async function resolveOwnItemStreams(config: UserConfig, id: string): Promise<StremioStream[]> {
  const { ref, season, episode } = decodeItemId(id);
  if (!ref) return [];

  if (ref.k !== 'series') {
    if (ref.u) return [{ name: 'IPTV', title: cleanTitle(ref.t).cleanTitle || ref.t, url: ref.u }];
    return [];
  }

  if (config.type === 'xtream' && ref.sid !== undefined && season !== undefined && episode !== undefined) {
    const client = new XtreamClient(config.host!, config.username!, config.password!);
    const eps = await client.getEpisodeStreams(ref.sid, season, episode);
    return eps.map((e) => ({
      name: `IPTV${e.quality ? ' ' + e.quality : ''}`,
      title: e.title,
      url: e.url,
      quality: e.quality
    }));
  }
  return [];
}

async function resolveGlobalStreams(
  env: Env,
  config: UserConfig,
  id: string,
  type: string,
  ctx: ExecutionContext
): Promise<StremioStream[]> {
  let season: number | undefined;
  let episode: number | undefined;
  let baseId = id;

  if (id.startsWith('tmdb:')) {
    const parts = id.split(':');
    baseId = `tmdb:${parts[1]}`;
    if (parts.length >= 4) {
      season = parseInt(parts[2], 10);
      episode = parseInt(parts[3], 10);
    }
  } else {
    const parts = id.split(':');
    baseId = parts[0];
    if (parts.length >= 3) {
      season = parseInt(parts[1], 10);
      episode = parseInt(parts[2], 10);
    }
  }

  const isSeries = type === 'series' || season !== undefined;
  const kind: MediaKind = isSeries ? 'series' : 'movie';

  // Fast path for cards opened from our own "Nouveautés" catalogs. The catalog
  // already resolved the IMDb id from a precise Xtream item, so reuse that
  // source directly instead of doing another TMDb lookup + provider-wide match.
  //
  // Movies can return the stored Xtream VOD URL immediately. Series keep the
  // stable episode resolver: we only skip the expensive title/TMDb matching
  // and call getEpisodeStreams() with the exact remembered Xtream series id.
  // If that exact series lookup yields no episode, fall through unchanged to
  // the known-good 2.9 matching logic below.
  if (config.type === 'xtream' && baseId.startsWith('tt')) {
    const remembered = await getRememberedCatalogSources(
      config,
      isSeries ? 'series' : 'movie',
      baseId
    );

    if (remembered.length) {
      const client = new XtreamClient(config.host!, config.username!, config.password!);

      if (!isSeries) {
        return remembered.map((ref) => ({
          name: 'IPTV',
          title: `${ref.title}${ref.category ? ` • ${ref.category}` : ''}`,
          url: client.movieUrl(ref.streamId, ref.containerExtension || 'mp4')
        }));
      }

      if (season !== undefined && episode !== undefined) {
        for (const ref of remembered) {
          const eps = await client.getEpisodeStreams(ref.streamId, season, episode);
          if (!eps.length) continue;
          return eps.map((e) => ({
            name: `IPTV${e.quality ? ' ' + e.quality : ''}`,
            title: `${ref.title} • S${season}E${episode}`,
            url: e.url,
            quality: e.quality
          }));
        }
      }
    }
  }

  const tmdb = tmdbFor(config, env, ctx);
  const availablePromise = getItems(config, kind, ctx);

  let titles: string[] = [];
  let year: number | undefined;
  let targetTmdbId: string | undefined;

  if (baseId.startsWith('tt')) {
    const found = await tmdb.getByImdbId(baseId);
    if (found) {
      // The /find response is intentionally light. Fetch the full TMDb object
      // so matching can also use localized and alternative titles.
      const full = found.details?.id ? await tmdb.getByTmdbId(found.details.id, found.type) : null;
      const src = full || found.details;
      targetTmdbId = src?.id !== undefined ? String(src.id) : undefined;
      titles = tmdb.collectTitles(src, found.type);
      const rd = src.release_date || src.first_air_date;
      if (rd) year = parseInt(String(rd).substring(0, 4), 10);
    }
  } else if (baseId.startsWith('tmdb:')) {
    const tmdbType = isSeries ? 'series' : 'movie';
    targetTmdbId = baseId.replace('tmdb:', '');
    const full = await tmdb.getByTmdbId(targetTmdbId, tmdbType);
    if (full) {
      titles = tmdb.collectTitles(full, tmdbType);
      const rd = full.release_date || full.first_air_date;
      if (rd) year = parseInt(String(rd).substring(0, 4), 10);
    }
  }

  if (!titles.length) {
    const fallback = baseId.replace(/^tmdb:/, '').replace(/^tt/, '').trim();
    if (fallback.length >= 2 && !/^\d+$/.test(fallback)) titles = [fallback];
  }
  if (!titles.length) return [];

  const available = await availablePromise;

  // Strongest possible match: some Xtream providers expose the TMDb id on
  // their VOD/series entries. Prefer that over any title comparison.
  const directTmdbMatches = targetTmdbId
    ? available.filter((item) => item.tmdbId && String(item.tmdbId) === targetTmdbId)
    : [];

  if (!isSeries && directTmdbMatches.length) {
    return itemsToStreams(directTmdbMatches.map((item) => ({ item, score: 1 })));
  }

  if (
    isSeries &&
    config.type === 'xtream' &&
    season !== undefined &&
    episode !== undefined &&
    directTmdbMatches.length
  ) {
    const client = new XtreamClient(config.host!, config.username!, config.password!);
    for (const item of directTmdbMatches.slice(0, 3)) {
      if (item.streamId === undefined) continue;
      const eps = await client.getEpisodeStreams(item.streamId, season, episode);
      if (eps.length) {
        return eps.map((e) => ({
          name: `IPTV${e.quality ? ' ' + e.quality : ''}`,
          title: `${item.title} • S${season}E${episode}`,
          url: e.url,
          quality: e.quality
        }));
      }
    }
  }

  const indexed = await getTitleMatches(config, kind as 'movie' | 'series', titles, ctx);
  const candidatePool = indexed.length ? indexed : available;

  const matches = rankMatches(titles[0], candidatePool, {
    targetYear: year,
    altTitles: titles.slice(1),
    targetSeason: config.type === 'm3u' ? season : undefined,
    targetEpisode: config.type === 'm3u' ? episode : undefined,
    minScore: 0.62
  });
  if (!matches.length) return [];

  if (!isSeries || config.type === 'm3u') return itemsToStreams(matches);

  if (config.type === 'xtream' && season !== undefined && episode !== undefined) {
    const client = new XtreamClient(config.host!, config.username!, config.password!);
    const out: StremioStream[] = [];
    for (const m of matches.slice(0, 3)) {
      if (m.item.streamId === undefined) continue;
      const eps = await client.getEpisodeStreams(m.item.streamId, season, episode);
      for (const e of eps) {
        out.push({
          name: `IPTV${e.quality ? ' ' + e.quality : ''}`,
          title: `${m.item.title} \u2022 S${season}E${episode}`,
          url: e.url,
          quality: e.quality
        });
      }
      if (out.length) break;
    }
    return out;
  }

  return [];
}
