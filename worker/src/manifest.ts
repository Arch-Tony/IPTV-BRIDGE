// Manifest generation. ONE catalog per enabled type; the user's IPTV categories
// are exposed through the Stremio `extra.genre` dropdown (options fetched from
// that user's provider), never as hundreds of separate catalogs.

import { getGenres } from './provider';
import { MediaKind, StremioCatalog, StremioManifest, UserConfig } from './types';

const STREMIO_ADDONS_SIGNATURE =
  'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..sDeakIt0DgWeZfmybeXOtg.4CyianytJ8NJmM7wv_juUymvNauoIMuz72EhdOouvhkXKEJNJ_UYV6f9WO7LHkN6USr1lGBcpvcs06asWY_26pmgQRT7AAeckgy2bTxJHqSfvq3sRkGiVcD0tYdejeTf.HkVET5t7lZd4yv_2mUiTow';

async function makeCatalog(
  config: UserConfig,
  ctx: ExecutionContext,
  type: 'tv' | 'movie' | 'series',
  kind: MediaKind,
  id: string,
  name: string
): Promise<StremioCatalog> {
  let options: string[] = [];
  try {
    const genres = await getGenres(config, kind, ctx);
    options = genres.map((g) => g.name);
  } catch {
    /* genre options are best-effort */
  }
  return {
    type,
    id,
    name,
    extra: [
      { name: 'search', isRequired: false },
      { name: 'genre', isRequired: false, options },
      { name: 'skip', isRequired: false }
    ]
  };
}

export async function getManifest(config: UserConfig, baseUrl: string, ctx: ExecutionContext): Promise<StremioManifest> {
  const configured = config.type === 'xtream' ? !!(config.host && config.username && config.password) : !!config.m3uUrl;

  const catalogs: StremioCatalog[] = [];
  if (configured) {
    const tasks: Promise<StremioCatalog>[] = [];
    // Sipario already handles the user's live Xtream source directly. This
    // personalized addon intentionally adds only the two useful home rows.
    if (config.includeMovies !== false)
      tasks.push(makeCatalog(config, ctx, 'movie', 'movie', 'recent_movies', 'Nouveautés films'));
    if (config.includeSeries !== false)
      tasks.push(makeCatalog(config, ctx, 'series', 'series', 'recent_series', 'Nouveautés séries'));
    catalogs.push(...(await Promise.all(tasks)));
  }

  const logo = `${baseUrl}/logo.png`;

  return {
    id: 'org.iptv.bridge.frrecent',
    version: '2.4.0',
    name: 'IPTV Bridge · Nouveautés FR',
    description:
      'Personal Sipario bridge — newest Xtream movies and series first, selected-category-only matching, Cinemeta/IMDb detail-page handoff and global stream resolution.',
    logo,
    resources: [
      { name: 'catalog', types: ['tv', 'movie', 'series'] },
      { name: 'meta', types: ['tv', 'movie', 'series'], idPrefixes: ['iptv:', 'tmdb:'] },
      { name: 'stream', types: ['movie', 'series', 'tv'], idPrefixes: ['iptv:', 'tt', 'tmdb:'] }
    ],
    types: ['tv', 'movie', 'series'],
    catalogs,
    idPrefixes: ['iptv:', 'tt', 'tmdb:'],
    behaviorHints: { configurable: true, configurationRequired: !configured },
    stremioAddonsConfig: { issuer: 'https://stremio-addons.net', signature: STREMIO_ADDONS_SIGNATURE }
  };
}
