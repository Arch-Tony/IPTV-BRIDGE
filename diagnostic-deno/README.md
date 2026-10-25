# Deno upstream diagnostic (isolated investigation only)

This diagnostic is separate from the production Cloudflare Worker. It makes **one** request to the fixed upstream endpoint `http://masprad.online/player_api.php`. It does not proxy IPTV streams and must not be connected to Nuvio.

## What it captures

The JSON response and Deno application logs include:
- diagnostic ID and timestamp, so the response can be matched to a log entry;
- upstream HTTP status and request duration;
- a safe allowlist of response headers when present (including `server`, `via`, `retry-after`, request/correlation IDs, cache/CDN indicators and content type);
- response size;
- on non-2xx responses, a short response-body preview with common credential/URL patterns redacted;
- on successful responses, whether JSON and Xtream `user_info` were present, and the account status/auth flag if returned;
- timeout/network error name and message if the request fails before an HTTP response.

It deliberately does **not** log the username, password, full request URL, full successful response body, or diagnostic token. Error-body redaction is best-effort, not a guarantee that arbitrary provider error text can never contain sensitive information. Review any preview before sharing it.

The diagnostic cannot access the provider's internal logs or reveal the exact rule that triggered a 429 if the provider does not disclose it. Some intermediaries also omit identifying headers.

## Deploy for a one-off test

1. In Deno Deploy, create a separate app from this repository and select branch `test/deno-upstream-diagnostic`.
2. Set the app entrypoint/root to `diagnostic-deno/main.ts` as the UI allows.
3. Add `DIAGNOSTIC_TOKEN` as a secret environment variable. Use a long random value; never commit or share it.
4. Deploy the diagnostic app. Keep its URL private and do not use it as an IPTV proxy.
5. Send **one** POST request from your own device/terminal to the deployed app. Use the actual app URL shown by Deno; do not assume the placeholder below is the correct hostname. Do not use a public online request tester.

Example (replace the URL, token, username and password locally; never send the request containing credentials in chat):
```sh
curl -sS -X POST 'https://YOUR-DENO-APP-URL/' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}'
```

## After the test

1. Save the JSON response, but check the error preview for sensitive information before sharing it.
2. In Deno Deploy, open the application's logs and locate the entry with the same `diagnosticId`. Share the sanitized log entry and JSON result; never share the token or IPTV credentials.
3. Compare the status and safe headers with the previously observed Cloudflare 429. Do not repeat the test unless the first run failed for a clear setup reason.

## Interpretation limits

- `upstreamStatus: 200` with `hasUserInfo: true`: Deno got an apparently valid Xtream response. This supports investigating differences between runtimes/egress, but alone does not prove Cloudflare IP blocking.
- `upstreamStatus: 429`: the provider or an upstream intermediary rate-limited this request from Deno too; headers/body may offer clues but may not identify the exact cause.
- Other status or a network error: preserve the exact output and logs; infer only what they show.

The response status from this diagnostic endpoint itself is normally HTTP 200 when the diagnostic ran; inspect the JSON field `upstreamStatus` for the provider's actual HTTP status. The endpoint returns 4xx/5xx directly only for its own request/configuration errors.
