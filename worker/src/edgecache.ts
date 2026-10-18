// Edge caching built on the Cloudflare Cache API (`caches.default`).
//
// Why not Workers KV? KV has a ~1000 writes/day cap on the free tier, which
// cannot support per-user provider indexes for ~1000 independent users. The
// Cache API has no write cap (it is the colo edge cache), so it is the right
// tool for both per-user provider data and the globally-shared TMDB cache.
//
// Two layers:
//   1. process-local in-flight de-duplication (collapses concurrent identical
//      lookups within a single isolate)
//   2. Cache API persistence across requests (per colo)

const inflight = new Map<string, Promise<unknown>>();

export interface EdgeCacheOptions {
  /** Keep a second copy longer so a temporary upstream failure can serve stale data. */
  staleIfErrorSec?: number;
  /** Open a per-provider circuit breaker after HTTP 429 to prevent request storms. */
  rateLimitBackoffSec?: number;
  /** Shared provider/account key so one 429 cools down all Xtream routes together. */
  rateLimitKey?: string;
}

function keyToRequest(key: string): Request {
  // Any absolute URL works as a cache key; the host is synthetic.
  return new Request(`https://iptv-bridge.cache/${encodeURIComponent(key)}`);
}

/**
 * Resolve `key` from the edge cache, or run `producer` once and cache the JSON
 * result for `ttlSec` seconds. Concurrent callers share one in-flight promise.
 */
export async function edgeCached<T>(
  ctx: ExecutionContext,
  key: string,
  ttlSec: number,
  producer: () => Promise<T>,
  options: EdgeCacheOptions = {}
): Promise<T> {
  const cache = caches.default;
  const req = keyToRequest(key);
  const staleReq = options.staleIfErrorSec ? keyToRequest(`${key}:stale`) : undefined;
  const cooldownKey = options.rateLimitKey || key;
  const cooldownReq = options.rateLimitBackoffSec
    ? keyToRequest(`ratelimit:${cooldownKey}`)
    : undefined;

  const readJson = async (request: Request | undefined): Promise<T | undefined> => {
    if (!request) return undefined;
    const hit = await cache.match(request);
    if (!hit) return undefined;
    try {
      return (await hit.json()) as T;
    } catch {
      return undefined;
    }
  };

  const hit = await readJson(req);
  if (hit !== undefined) return hit;

  // If this provider recently returned 429, never probe it again during the
  // cooldown. Serve the last good provider snapshot when available.
  if (cooldownReq && (await cache.match(cooldownReq))) {
    const stale = await readJson(staleReq);
    if (stale !== undefined) return stale;
    const error: any = new Error('Upstream 429 (cooldown)');
    error.status = 429;
    throw error;
  }

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = (async () => {
    try {
      const value = await producer();
      const body = JSON.stringify(value);
      const fresh = new Response(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${ttlSec}`
        }
      });
      ctx.waitUntil(cache.put(req, fresh));

      if (staleReq && options.staleIfErrorSec) {
        const stale = new Response(body, {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${options.staleIfErrorSec}`
          }
        });
        ctx.waitUntil(cache.put(staleReq, stale));
      }

      return value;
    } catch (err: any) {
      if (err?.status === 429 && cooldownReq && options.rateLimitBackoffSec) {
        const hinted = Number(err?.retryAfterSeconds);
        const requested = Number.isFinite(hinted) && hinted > 0 ? hinted : options.rateLimitBackoffSec;
        const cooldownSec = Math.max(60, Math.min(60 * 60, Math.ceil(requested)));
        const marker = new Response('1', {
          headers: { 'Cache-Control': `public, max-age=${cooldownSec}` }
        });
        ctx.waitUntil(cache.put(cooldownReq, marker));
      }

      const stale = await readJson(staleReq);
      if (stale !== undefined) return stale;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** Read a JSON value from the edge cache without creating a fallback entry. */
export async function edgeGet<T>(key: string): Promise<T | undefined> {
  const hit = await caches.default.match(keyToRequest(key));
  if (!hit) return undefined;
  try {
    return (await hit.json()) as T;
  } catch {
    return undefined;
  }
}

/** Store a JSON value in the edge cache. */
export function edgePut<T>(ctx: ExecutionContext, key: string, value: T, ttlSec: number): void {
  const res = new Response(JSON.stringify(value), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttlSec}`
    }
  });
  ctx.waitUntil(caches.default.put(keyToRequest(key), res));
}

export const TTL = {
  CATEGORIES: 6 * 60 * 60, // 6h
  STREAMS: 60 * 60, // 1h — drastically reduce Xtream refresh pressure while keeping catalogs reasonably fresh
  PLAYLIST: 3 * 60 * 60, // 3h
  EPISODES: 60 * 60, // 1h
  TMDB: 24 * 60 * 60, // 24h
  CATALOG_MAP: 60 * 60, // 1h — exact selected-provider source behind canonical IMDb cards
  PROVIDER_STALE: 24 * 60 * 60, // 24h last-known-good Xtream snapshot
  RATE_LIMIT_BACKOFF: 15 * 60 // 15m minimum circuit-breaker after upstream 429
};
