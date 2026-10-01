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
  producer: () => Promise<T>
): Promise<T> {
  const cache = caches.default;
  const req = keyToRequest(key);

  const hit = await cache.match(req);
  if (hit) {
    try {
      return (await hit.json()) as T;
    } catch {
      /* fall through and re-produce on corrupt cache entry */
    }
  }

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = (async () => {
    try {
      const value = await producer();
      const res = new Response(JSON.stringify(value), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${ttlSec}`
        }
      });
      ctx.waitUntil(cache.put(req, res.clone()));
      return value;
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
  STREAMS: 5 * 60, // 5m — keep Sipario novelty rows close to the provider
  PLAYLIST: 3 * 60 * 60, // 3h
  EPISODES: 60 * 60, // 1h
  TMDB: 24 * 60 * 60, // 24h
  CATALOG_MAP: 24 * 60 * 60 // 24h — remember which Xtream item produced an IMDb catalog card
};
