# BMW Care — Webhook Proxy (Cloudflare Worker)

Tiny edge worker that handles **Smartcar webhook verification** (HMAC challenge) then forwards regular events to the Notion Worker's webhook URL.

Why: Notion Workers' `worker.webhook` execute handler returns `void`, so Notion's framework auto-replies `{eventId: ...}`. Smartcar's verification step requires the response body to be `{challenge: HMAC_SHA256(application_management_token, challenge_string)}`, which Notion can't produce. This proxy sits in between.

## Setup

```bash
cd cf-webhook-proxy
npm install
npx wrangler login

# Secrets
npx wrangler secret put APPLICATION_MANAGEMENT_TOKEN
# Paste the Smartcar Application Management Token (Configuration → API credentials → Regenerate token)

npx wrangler secret put NOTION_WEBHOOK_URL
# Paste the URL from: ntn workers webhooks ls
# (looks like https://www.notion.so/webhooks/worker/<spaceId>/<workerId>/<uniqueId>/smartcarEvents)

npx wrangler deploy
```

Wrangler prints the public URL of the deployed worker (e.g., `https://bmw-care-webhook-proxy.<your-subdomain>.workers.dev`).

## Wire it into Smartcar

Smartcar Dashboard → **Webhooks** → **Edit** the existing webhook → set **Callback URI** to the Cloudflare URL above. Save. Smartcar will re-run VERIFY against this URL; the HMAC response will succeed, and the webhook will activate.

Subsequent events (vehicle state changes in scheduled or stream mode) get forwarded to Notion's webhook URL, which is logged by the `smartcarEvents` capability in the main worker.

## Test locally

```bash
npx wrangler dev
# In another terminal:
curl -X POST http://localhost:8787 \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"VERIFY","data":{"challenge":"challenge_test123"}}'
# Should return: {"challenge":"<64-hex>"}

# And a forwarded event:
curl -X POST http://localhost:8787 \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"VEHICLE_STATE","data":{"vehicleId":"abc"}}'
# Should return what Notion's webhook returns (e.g., {"eventId":"..."}).
```

## How the verify works

Smartcar sends `POST { eventType: "VERIFY", data: { challenge: "challenge_xxx" } }`. The proxy:

1. Computes `HMAC-SHA256(APPLICATION_MANAGEMENT_TOKEN, "challenge_xxx")` in lowercase hex.
2. Returns `{ "challenge": "<that hex>" }` with `Content-Type: application/json`.

Anything else is treated as a real event and forwarded verbatim to Notion. The proxy strips host/content-length/cf-* headers before forwarding to avoid corrupting the request.
