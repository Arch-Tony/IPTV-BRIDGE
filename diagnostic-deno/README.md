# Deno upstream diagnostic (isolated test only)

This folder is deliberately independent of the production Cloudflare Worker. It makes one request to the fixed upstream host `http://masprad.online/player_api.php` and reports only status/timing/limited response metadata. It never returns or logs credentials or the upstream response body.

## Deploy for a one-off test

1. In Deno Deploy, create a new app from this repository and set the app's root/entrypoint to `diagnostic-deno/main.ts`.
2. Add a secret environment variable named `DIAGNOSTIC_TOKEN` in the app settings. Choose a long random value. Do not commit it to GitHub or send it in chat.
3. Deploy the app. Keep the URL private; this is a diagnostic endpoint, not a production proxy.
4. Send one POST request to the deployed app with header `Authorization: Bearer YOUR_TOKEN`, content type `application/json`, and JSON body containing your Xtream username and password. Do not use a public online request tester.
5. Compare `upstreamStatus` with the already-observed Cloudflare 429. Do not repeat requests unnecessarily.

Example request from a local terminal (replace the URL and token locally; enter credentials locally, never in source code):
```sh
curl -sS -X POST 'https://YOUR-DENO-APP.deno.net/' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}'
```

Interpretation:
- `200` with `hasUserInfo: true`: Deno can reach and authenticate to the provider. This supports investigating a separate runtime/egress difference, but does not prove Cloudflare IP blocking by itself.
- `429`: the provider also rate-limited this request from Deno.
- Other status/network error: retain the exact diagnostic output; do not infer more than it shows.

This test is not a replacement IPTV proxy. Do not connect it to Nuvio or change the production Worker URL based on this test alone.
