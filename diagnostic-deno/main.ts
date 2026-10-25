// Isolated upstream diagnostic for the IPTV-Bridge investigation.
// This file is independent of the production Cloudflare Worker.
// Set DIAGNOSTIC_TOKEN as a secret in Deno Deploy. Never commit credentials/tokens.

const UPSTREAM = "http://masprad.online";
const MAX_ERROR_PREVIEW = 1200;
const SAFE_HEADERS = [
  "date",
  "server",
  "via",
  "retry-after",
  "content-type",
  "www-authenticate",
  "server-timing",
  "x-request-id",
  "x-correlation-id",
  "x-cache",
  "cf-ray",
  "cf-cache-status",
  "x-powered-by",
];
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function reply(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: corsHeaders,
  });
}

function safeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of SAFE_HEADERS) {
    const value = headers.get(name);
    if (value) result[name] = value.slice(0, 300);
  }
  return result;
}

function scrub(value: string, username: string, password: string): string {
  return value
    .replaceAll(username, "[REDACTED_USERNAME]")
    .replaceAll(password, "[REDACTED_PASSWORD]")
    .replace(/([?&](?:username|password)=)[^&\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL_REDACTED]")
    .slice(0, MAX_ERROR_PREVIEW);
}

function logEvent(event: Record<string, unknown>) {
  // Never pass credentials, the request URL, or the full successful body here.
  console.log(JSON.stringify({ service: "iptv-upstream-diagnostic", ...event }));
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

  const username = input.username.trim();
  const password = input.password.trim();
  const diagnosticId = crypto.randomUUID();
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const url = new URL("/player_api.php", UPSTREAM);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);

  try {
    const upstream = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "IPTVSmartersPro/3.0.0" },
      signal: controller.signal,
      redirect: "manual",
    });
    const durationMs = Date.now() - started;
    const headers = safeHeaders(upstream.headers);
    const rawBody = await upstream.text();
    const result: Record<string, unknown> = {
      diagnosticId,
      checkedAt: new Date().toISOString(),
      ok: upstream.ok,
      upstreamStatus: upstream.status,
      durationMs,
      headers,
      responseBytes: new TextEncoder().encode(rawBody).length,
    };

    if (upstream.ok) {
      try {
        const body = JSON.parse(rawBody);
        result.jsonReceived = !!body && typeof body === "object";
        result.hasUserInfo = !!body?.user_info;
        if (typeof body?.user_info?.status === "string") {
          result.accountStatus = body.user_info.status;
        }
        if (body?.user_info?.auth !== undefined) {
          result.authFlag = body.user_info.auth;
        }
      } catch {
        result.jsonReceived = false;
        result.successBodyPreview = scrub(rawBody, username, password);
      }
    } else {
      // A short, scrubbed error preview can help identify provider/CDN messages.
      result.errorBodyPreview = scrub(rawBody, username, password);
    }

    logEvent({
      diagnosticId,
      checkedAt: result.checkedAt,
      upstreamStatus: upstream.status,
      durationMs,
      responseBytes: result.responseBytes,
      headers,
      errorBodyPreview: upstream.ok ? undefined : result.errorBodyPreview,
      jsonReceived: result.jsonReceived,
      hasUserInfo: result.hasUserInfo,
      accountStatus: result.accountStatus,
    });
    return reply(200, result);
  } catch (error) {
    const durationMs = Date.now() - started;
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const errorMessage = error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
    const isTimeout = errorName === "AbortError";
    const result = {
      diagnosticId,
      checkedAt: new Date().toISOString(),
      ok: false,
      error: isTimeout ? "timeout" : "network_error",
      errorName,
      errorMessage,
      durationMs,
    };
    logEvent(result);
    return reply(200, result);
  } finally {
    clearTimeout(timeout);
  }
});
