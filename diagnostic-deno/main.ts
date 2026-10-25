// Isolated diagnostic endpoint for checking upstream reachability from Deno Deploy.
// This file is intentionally separate from the Cloudflare Worker app.
// Configure DIAGNOSTIC_TOKEN as a secret environment variable in Deno Deploy.
// Never put IPTV credentials or the token in source control.

const UPSTREAM = "http://masprad.online";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8",
};

function reply(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { ok: false, error: "POST required" });

  const expected = Deno.env.get("DIAGNOSTIC_TOKEN");
  if (!expected) return reply(503, { ok: false, error: "Diagnostic token is not configured" });
  const supplied = request.headers.get("Authorization") || "";
  if (supplied !== `Bearer ${expected}`) return reply(401, { ok: false, error: "Unauthorized" });

  let input: { username?: unknown; password?: unknown };
  try {
    input = await request.json();
  } catch {
    return reply(400, { ok: false, error: "Invalid JSON" });
  }
  if (typeof input.username !== "string" || typeof input.password !== "string" ||
      !input.username.trim() || !input.password.trim()) {
    return reply(400, { ok: false, error: "username and password are required" });
  }

  const url = new URL("/player_api.php", UPSTREAM);
  url.searchParams.set("username", input.username.trim());
  url.searchParams.set("password", input.password.trim());

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const upstream = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "IPTVSmartersPro/3.0.0" },
      signal: controller.signal,
    });
    const result: Record<string, unknown> = {
      ok: upstream.ok,
      upstreamStatus: upstream.status,
      durationMs: Date.now() - started,
      contentType: upstream.headers.get("content-type"),
      retryAfter: upstream.headers.get("retry-after"),
    };
    if (upstream.ok) {
      try {
        const body = await upstream.json();
        result.jsonReceived = !!body && typeof body === "object";
        result.hasUserInfo = !!body?.user_info;
        result.accountStatus = typeof body?.user_info?.status === "string"
          ? body.user_info.status
          : undefined;
      } catch {
        result.jsonReceived = false;
      }
    }
    return reply(200, result);
  } catch (error) {
    return reply(200, {
      ok: false,
      error: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error",
      durationMs: Date.now() - started,
    });
  } finally {
    clearTimeout(timeout);
  }
});
