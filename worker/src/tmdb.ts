// TMDB client (fetch-only) with GLOBAL edge caching.
//
// TMDB data is identical for every user, so cache keys deliberately exclude the
// api key: the first user to look up a title warms the cache for everyone. This
// is what moves TMDB resolution off the per-request hot path for movie search.

import { edgeCached, TTL } from './edgecache';
import { StremioMeta } from './types';

const BASE = 'https://api.themoviedb.org/3';
const DEFAULT_KEY = 'a82e9b89737119f91a508f71052fb58f';

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export class TMDBClient {
  private readonly apiKey: string;
  private readonly ctx: ExecutionContext;

  constructor(apiKey: string | undefined, ctx: ExecutionContext) {
    this.apiKey = apiKey && apiKey.trim() ? apiKey.trim() : DEFAULT_KEY;
    this.ctx = ctx;
  }

  /** Cached GET. `cacheKey` must NOT include the api key (shared globally). */
  private get(cacheKey: string, url: string): Promise<any | null> {
    return edgeCached(this.ctx, `tmdb:${cacheKey}`, TTL.TMDB, () => fetchJson(url));
  }

  async getByImdbId(imdbId: string): Promise<{ type: 'movie' | 'series'; details: any } | null> {
    const data = await this.get(
      `find:fr:${imdbId}`,
      `${BASE}/find/${encodeURIComponent(imdbId)}?api_key=${this.apiKey}&external_source=imdb_id&language=fr-FR`
    );
    if (!data) return null;
    if (data.movie_results?.length) return { type: 'movie', details: data.movie_results[0] };
    if (data.tv_results?.length) return { type: 'series', details: data.tv_results[0] };
    return null;
  }

  async getByTmdbId(tmdbId: number | string, type: 'movie' | 'series'): Promise<any | null> {
    const cleanId = String(tmdbId).replace(/^tmdb:/, '');
    const endpoint = type === 'movie' ? 'movie' : 'tv';
    return this.get(
      `${type}:fr:${cleanId}`,
      `${BASE}/${endpoint}/${encodeURIComponent(cleanId)}?api_key=${this.apiKey}&language=fr-FR&append_to_response=external_ids,alternative_titles,credits,videos`
    );
  }

  collectTitles(tmdbData: any, type: 'movie' | 'series'): string[] {
    const titles = new Set<string>();
    const primary = type === 'movie' ? tmdbData.title || tmdbData.original_title : tmdbData.name || tmdbData.original_name;
    if (primary) titles.add(primary);
    if (tmdbData.original_title) titles.add(tmdbData.original_title);
    if (tmdbData.original_name) titles.add(tmdbData.original_name);
    const alts = tmdbData.alternative_titles?.titles || tmdbData.alternative_titles?.results || [];
    for (const a of alts) if (a?.title) titles.add(a.title);
    return [...titles];
  }

  async getSeasonEpisodes(tmdbId: number | string, season: number): Promise<any[]> {
    const cleanId = String(tmdbId).replace(/^tmdb:/, '');
    const data = await this.get(
      `season:fr:${cleanId}:${season}`,
      `${BASE}/tv/${encodeURIComponent(cleanId)}/season/${season}?api_key=${this.apiKey}&language=fr-FR`
    );
    return data?.episodes || [];
  }

  async bestSearchMatch(title: string, type: 'movie' | 'series', year?: number): Promise<any | null> {
    const endpoint = type === 'movie' ? 'movie' : 'tv';
    let url = `${BASE}/search/${endpoint}?api_key=${this.apiKey}&query=${encodeURIComponent(title)}&include_adult=false&language=fr-FR`;
    let key = `search:fr:${type}:${title.toLowerCase()}:${year || ''}`;
    if (year) url += type === 'movie' ? `&year=${year}` : `&first_air_date_year=${year}`;
    const data = await this.get(key, url);
    const results = data?.results;
    return Array.isArray(results) && results.length ? results[0] : null;
  }

  formatToStremioMeta(tmdbData: any, type: 'movie' | 'series', overrideId?: string): StremioMeta {
    const isMovie = type === 'movie';
    const id = overrideId || tmdbData.external_ids?.imdb_id || `tmdb:${tmdbData.id}`;
    const name = isMovie ? tmdbData.title || tmdbData.original_title : tmdbData.name || tmdbData.original_name;
    const releaseDate = isMovie ? tmdbData.release_date : tmdbData.first_air_date;
    const year = releaseDate ? String(releaseDate).substring(0, 4) : undefined;

    const directors = (tmdbData.credits?.crew || [])
      .filter((p: any) => p?.job === 'Director' && p?.name)
      .map((p: any) => p.name)
      .slice(0, 5);
    const cast = (tmdbData.credits?.cast || [])
      .filter((p: any) => p?.name)
      .map((p: any) => p.name)
      .slice(0, 20);
    const trailers = (tmdbData.videos?.results || [])
      .filter((v: any) => v?.site === 'YouTube' && v?.key && ['Trailer', 'Teaser', 'Clip'].includes(v.type))
      .slice(0, 6)
      .map((v: any) => ({ source: String(v.key), type: v.type === 'Trailer' ? 'Trailer' : 'Clip' as 'Trailer' | 'Clip' }));
    const runtimeMinutes = isMovie ? tmdbData.runtime : tmdbData.episode_run_time?.[0];

    return {
      id,
      type: isMovie ? 'movie' : 'series',
      name: name || 'Unknown Title',
      poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : undefined,
      background: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}` : undefined,
      description: tmdbData.overview,
      year,
      releaseInfo: year,
      released: releaseDate ? `${releaseDate}T00:00:00.000Z` : undefined,
      runtime: runtimeMinutes ? `${runtimeMinutes}m` : undefined,
      imdbRating: tmdbData.vote_average ? String(Math.round(tmdbData.vote_average * 10) / 10) : undefined,
      genres: tmdbData.genres ? tmdbData.genres.map((g: any) => g.name) : [],
      director: directors.length ? directors : undefined,
      cast: cast.length ? cast : undefined,
      trailers: trailers.length ? trailers : undefined
    };
  }
}
