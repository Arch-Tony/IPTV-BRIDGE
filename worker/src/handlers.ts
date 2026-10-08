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

interface CatalogCardResolution {
  externalId?: string;
  background?: string;
  logo?: string;
  status?: string;
  lastAirDate?: string;
  originalLanguage?: string;
  originCountries?: string[];
  genreIds?: number[];
}

async function resolveCatalogCard(
  item: Awaited<ReturnType<typeof getItems>>[number],
  kind: 'movie' | 'series',
  tmdb: TMDBClient
): Promise<CatalogCardResolution> {
  const clean = cleanTitle(item.title).cleanTitle || item.title;

  let full: any | null = null;
  if (item.tmdbId && /^\d+$/.test(item.tmdbId)) {
    full = await tmdb.getCatalogCard(item.tmdbId, kind);
  } else {
    const found = await tmdb.bestSearchMatch(clean, kind, item.year);
    if (!found?.id) return {};

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
      if (Math.abs(resultYear - item.year) > 1) return {};
    } else if (!titleMatches) {
      return {};
    }

    full = await tmdb.getCatalogCard(found.id, kind);
  }

  if (!full) return {};

  const imdbId = full.external_ids?.imdb_id;
  const externalId =
    typeof imdbId === 'string' && /^tt\d+$/.test(imdbId)
      ? imdbId
      : undefined;
  const artwork = tmdb.catalogArtwork(full);
  const originCountries =
    kind === 'movie'
      ? (Array.isArray(full.production_countries)
          ? full.production_countries
              .map((country: any) => country?.iso_3166_1)
              .filter((country: unknown): country is string => typeof country === 'string' && !!country)
          : [])
      : (Array.isArray(full.origin_country)
          ? full.origin_country.filter((country: unknown): country is string => typeof country === 'string' && !!country)
          : []);
  const genreIds = Array.isArray(full.genres)
    ? full.genres
        .map((genre: any) => Number(genre?.id))
        .filter((id: number) => Number.isFinite(id))
    : [];

  return {
    externalId,
    background: artwork.background,
    logo: artwork.logo,
    status: typeof full.status === 'string' ? full.status : undefined,
    lastAirDate: typeof full.last_air_date === 'string' ? full.last_air_date : undefined,
    originalLanguage: typeof full.original_language === 'string' ? full.original_language : undefined,
    originCountries,
    genreIds
  };
}

function isEastAsianAnimation(card: CatalogCardResolution): boolean {
  // Hide confirmed East-Asian animation from IPTV Bridge catalog rows only.
  // This covers Japanese anime plus Chinese donghua and Korean animation,
  // while keeping Western adult animation such as The Simpsons, Futurama,
  // Golden Axe or Get Jiro. Provider items remain available to stream matching.
  const isAnimation = card.genreIds?.includes(16) === true;
  if (!isAnimation) return false;

  const originalLanguage = (card.originalLanguage || '').trim().toLowerCase();
  const asianLanguage =
    originalLanguage === 'ja' ||
    originalLanguage === 'ko' ||
    originalLanguage === 'zh' ||
    originalLanguage.startsWith('zh-');

  const asianCountries = new Set(['JP', 'KR', 'CN', 'TW', 'HK']);
  const fromEastAsia =
    card.originCountries?.some((country) => asianCountries.has(country.toUpperCase())) === true;

  return asianLanguage || fromEastAsia;
}

function shouldHideAnimationCatalogItem(
  item: Awaited<ReturnType<typeof getItems>>[number],
  card: CatalogCardResolution
): boolean {
  if (isEastAsianAnimation(card)) return true;

  // Some provider anime entries fail TMDB matching entirely. In that case the
  // detail page falls back to "IPTV title" and we have no country/language data
  // to classify them. Only for clearly anime/manga-labelled provider categories,
  // hide unresolved items from catalog rows. Resolved Western animation in the
  // same broad category remains visible.
  const category = (item.category || '').toLowerCase();
  const animeCategory =
    /(^|[^a-z])(anime|manga|japan|japanese|japon|japonais|donghua)([^a-z]|$)/i.test(category);

  const resolved =
    !!card.externalId ||
    !!card.originalLanguage ||
    (card.originCountries?.length || 0) > 0 ||
    (card.genreIds?.length || 0) > 0;

  return animeCategory && !resolved;
}

function isStaleEndedSeries(card: CatalogCardResolution): boolean {
  const status = (card.status || '').trim().toLowerCase();
  if (!['ended', 'canceled', 'cancelled'].includes(status)) return false;
  if (!card.lastAirDate) return false;

  const lastAirMs = Date.parse(card.lastAirDate);
  if (!Number.isFinite(lastAirMs)) return false;

  // "Nouveautés séries" is meant to surface active/recent shows. Ignore a
  // provider-side last_modified bump on a show that actually ended years ago.
  const twoYearsMs = 730 * 24 * 60 * 60 * 1000;
  return lastAirMs < Date.now() - twoYearsMs;
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

  // Nuvio home rows: newest provider additions first.
  // Series use last_modified when available so a new episode can surface the show.
  if (kind === 'movie' || kind === 'series') {
    const recentTs = (item: (typeof items)[number]): number =>
      kind === 'series' ? item.updatedAt ?? item.addedAt ?? 0 : item.addedAt ?? item.updatedAt ?? 0;
    items = [...items].sort((a, b) => recentTs(b) - recentTs(a));
  }

  if (search) {
    const q = search.toLowerCase();
    items = items.filter((i) => i.title.toLowerCase().includes(q) || i.cleanTitle.toLowerCase().includes(q));
  }

  // Resolve movie/series cards to a canonical IMDb id so Nuvio, AIO Metadata
  // and this IPTV catalog all refer to the same logical title and watch state.
  // Keep pages at 20: a cache miss can require up to two TMDb requests per item.
  let page = items.slice(skip, skip + CATALOG_PAGE_SIZE);
  let catalogCards: CatalogCardResolution[] = page.map(() => ({}));
  if (kind === 'movie' || kind === 'series') {
    const tmdb = tmdbFor(config, env, ctx);
    catalogCards = await Promise.all(page.map((item) => resolveCatalogCard(item, kind, tmdb)));

    const nonAnime = page
      .map((item, index) => ({ item, card: catalogCards[index] }))
      .filter(({ item, card }) => !shouldHideAnimationCatalogItem(item, card));
    page = nonAnime.map(({ item }) => item);
    catalogCards = nonAnime.map(({ card }) => card);

    if (kind === 'series') {
      const kept = page
        .map((item, index) => ({ item, card: catalogCards[index] }))
        .filter(({ card }) => !isStaleEndedSeries(card));
      page = kept.map(({ item }) => item);
      catalogCards = kept.map(({ card }) => card);
    }
  }

  // Remember the exact selected Xtream source behind each canonical IMDb card.
  // This mapping is stream-only; IPTV Bridge never serves metadata for tt... ids.
  if (kind === 'movie' || kind === 'series') {
    const grouped = new Map<string, CatalogSourceRef[]>();
    page.forEach((item, index) => {
      const externalId = catalogCards[index]?.externalId;
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
    // Fall back to the internal id only when canonical matching is uncertain.
    id: catalogCards[index]?.externalId || encodeItemId(item),
    type: params.type,
    name: cleanTitle(item.title).cleanTitle || item.title,
    poster: item.logo || fallbackPoster,
    posterShape: kind === 'channel' ? 'square' : 'poster',
    background: catalogCards[index]?.background,
    logo: catalogCards[index]?.logo,
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

  // Cards from our own novelty rows already established a precise
  // IMDb -> Xtream relationship. Reuse it for playback, but intersect it with
  // the currently selected provider items so excluded categories stay excluded.
  if (config.type === 'xtream' && baseId.startsWith('tt')) {
    const [remembered, allowedItems] = await Promise.all([
      getRememberedCatalogSources(config, isSeries ? 'series' : 'movie', baseId),
      getItems(config, kind, ctx)
    ]);
    const allowedIds = new Set(
      allowedItems
        .filter((item) => item.streamId !== undefined)
        .map((item) => String(item.streamId))
    );
    const allowedRemembered = remembered.filter((ref) => allowedIds.has(String(ref.streamId)));

    if (allowedRemembered.length) {
      const client = new XtreamClient(config.host!, config.username!, config.password!);

      if (!isSeries) {
        // Catalog pages contain only 20 entries. Other editions of the same film
        // may be on a different page, so supplement the remembered refs from the
        // full allowed provider list. Never expand to a different title or year.
        const known = new Set(allowedRemembered.map((ref) => String(ref.streamId)));
        const refs = [...allowedRemembered];
        const seeds = allowedRemembered.map((ref) => ({
          identity: titleIdentity(ref.title),
          year: cleanTitle(ref.title).year,
          tmdbId: ref.tmdbId
        }));
        for (const item of allowedItems) {
          if (item.streamId === undefined || known.has(String(item.streamId))) continue;
          const identity = titleIdentity(item.title);
          const candidateYear = item.year ?? cleanTitle(item.title).year;
          if (!seeds.some((seed) =>
            seed.identity && identity === seed.identity &&
            !(seed.year && candidateYear && seed.year !== candidateYear) &&
            !(seed.tmdbId && item.tmdbId && seed.tmdbId !== item.tmdbId)
          )) continue;
          known.add(String(item.streamId));
          refs.push({
            streamId: item.streamId,
            title: item.title,
            containerExtension: item.containerExtension,
            category: item.category,
            tmdbId: item.tmdbId
          });
        }
        const qualityRank = (title: string): number => {
          const quality = cleanTitle(title).quality;
          return quality === '4K UHD' ? 4 : quality === '1080p' ? 3 :
            quality === '720p' ? 2 : quality === 'SD' ? 1 : 0;
        };
        refs.sort((a, b) => qualityRank(b.title) - qualityRank(a.title));
        return refs.map((ref) => {
          const quality = cleanTitle(ref.title).quality;
          return {
            name: `IPTV${quality ? ' ' + quality : ''}`,
            title: `${ref.title}${ref.category ? ` • ${ref.category}` : ''}`,
            url: client.movieUrl(ref.streamId, ref.containerExtension || 'mp4'),
            quality
          };
        });
      }

      if (season !== undefined && episode !== undefined) {
        for (const ref of allowedRemembered) {
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
      // Never cross movie/series boundaries. Nuvio already tells us the type.
      if ((isSeries && found.type !== 'series') || (!isSeries && found.type !== 'movie')) return [];

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

  // Strongest match first when the provider exposes a TMDb id.
  const directTmdbMatches = targetTmdbId
    ? available.filter((item) => item.tmdbId && String(item.tmdbId) === targetTmdbId)
    : [];

  if (!isSeries && directTmdbMatches.length) {
    // TMDb identifiers are the strongest evidence, but an Xtream provider may
    // assign TMDb IDs to only one of several HD/4K releases of the same movie.
    // Expand the direct match with exact-title editions from selected categories,
    // rejecting different years or a conflicting known TMDb ID.
    const exactTitles = new Set(directTmdbMatches.map((item) => titleIdentity(item.title)).filter(Boolean));
    const refs = available.filter((item) => {
      if (item.tmdbId && String(item.tmdbId) === targetTmdbId) return true;
      if (!exactTitles.has(titleIdentity(item.title))) return false;
      const itemYear = item.year ?? cleanTitle(item.title).year;
      if (year && itemYear && Math.abs(year - itemYear) > 1) return false;
      if (item.tmdbId && String(item.tmdbId) !== targetTmdbId) return false;
      return true;
    });
    const seen = new Set<string>();
    const unique = refs.filter((item) => {
      const id = String(item.streamId ?? item.url ?? item.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return itemsToStreams(unique.map((item) => ({ item, score: 1 })));
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
    minScore: 0.78
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
