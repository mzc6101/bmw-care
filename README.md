# BMW Care

A "garage in Notion" — your BMW's live telemetry synced into Notion databases, queryable through a Notion agent, with preventative-maintenance projections backed by BMW research.

Built at the **Notion Developer Platform Hackathon** (May 16–17, 2026).

## What you get

| Database | What it shows |
|---|---|
| **Vehicles** | Live snapshot per VIN: mileage, fuel/battery, oil life, range, location, lock state |
| **Vehicle Health Summary** | Overall health (🟢/🟡/🔴) + per-status item counts per vehicle |
| **Vehicle Health** | Per-service rule status (OK/SOON/DUE/OVERDUE) with last-service mileage + projected next due |
| **Maintenance Schedule (BMW)** | 11 research-backed rules covering ICE + EV BMWs |
| **Service Records** | Built-in simulator records + your own — drives the health math |
| **Tire Pressure** | Per-wheel kPa + psi |
| **Alerts** | Auto-derived: low fuel/battery, low oil life, tire pressure, diagnostic statuses |

## Maintenance rules (researched)

Auto-detected per vehicle so an i4/iX doesn't get spark-plug recommendations.

- **Engine Oil & Filter** — 10k mi or 12mo (ICE)
- **Cabin Air Filter** — 22.5k mi or 24mo (Both)
- **Engine Air Filter** — 30k mi (ICE)
- **Brake Fluid Flush** — 24mo (Both)
- **Spark Plugs** — 60k mi, extends to 75k (ICE)
- **Auto Transmission Fluid** — 60k mi, extends to 100k (ICE)
- **HV Battery Coolant** — 75k mi or 60mo (EV)
- **Engine Coolant** — 60k mi or 48mo (ICE)
- **Tire Rotation** — 7.5k mi (Both)
- **Wiper Blades** — 12mo (Both)
- **Annual Inspection** — 12mo / 10k mi (Both)

Sources: BMW USA maintenance schedule, i4/iX maintenance guides, dealer & specialist consensus.

## Architecture

```
  Smartcar V3 API              Notion Worker (TypeScript)              Notion workspace
  ───────────────              ──────────────────────────              ─────────────────
  iam.smartcar.com    ◀──── M2M client_credentials (1h Bearer, cached)
  /oauth2/token

  vehicle.api.smartcar.com/v3/connections           ◀── connections()
  vehicle.api.smartcar.com/v3/vehicles/{id}/signals ◀── snapshot() (54 → typed Snapshot)
                                 │
                                 ├─ sync("vehicleStatus")        15m  ──▶  Vehicles
                                 ├─ sync("tiresSync")             1h  ──▶  Tire Pressure
                                 ├─ sync("serviceRecordsSync")    1h  ──▶  Service Records
                                 ├─ sync("alertsDerived")        15m  ──▶  Alerts
                                 ├─ sync("maintenanceRules")    daily ──▶  Maintenance Schedule
                                 ├─ sync("vehicleHealthOutlook") 30m  ──▶  Vehicle Health
                                 └─ sync("vehicleHealthRollup")  30m  ──▶  Vehicle Health Summary

                                 ├─ tool("getVehicleStatus")          ◀── @agent fetches live snapshot
                                 ├─ tool("canIMakeIt")                ◀── "Will my range cover N miles?"
                                 ├─ tool("getMaintenanceStatus")      ◀── full projection on demand
                                 └─ tool("logService")                ◀── record a service performed

                                 webhook("smartcarEvents")            ◀── (stretch: needs CF Worker proxy for VERIFY)
```

## Setup

```bash
# 1. Install Notion CLI
curl -fsSL https://ntn.dev | NTN_INSTALL_DIR="$HOME/.local/bin" bash
ntn login

# 2. Smartcar dashboard
#    - Configuration → API credentials: copy Client ID + Client Secret
#    - Simulator → Add simulated vehicle (BMW). It auto-attaches via /v3/connections.

# 3. Deploy
npm install
npm run check
ntn workers deploy --name bmw-care
ntn workers env set SMARTCAR_CLIENT_ID=client_01...
ntn workers env set SMARTCAR_CLIENT_SECRET=...

# 4. Kick off first sync
ntn workers sync trigger vehicleStatus
ntn workers sync trigger tiresSync
ntn workers sync trigger serviceRecordsSync
ntn workers sync trigger maintenanceRules
ntn workers sync trigger alertsDerived
ntn workers sync trigger vehicleHealthOutlook
ntn workers sync trigger vehicleHealthRollup

ntn workers sync status         # all should be HEALTHY
```

## Test the tools

```bash
ntn workers exec getVehicleStatus -d '{}'
ntn workers exec canIMakeIt -d '{"destination_miles": 380}'
ntn workers exec getMaintenanceStatus -d '{"horizon_miles": null}'
ntn workers exec logService -d '{
  "service": "Engine Oil & Filter",
  "mileage_at_service": 48500,
  "service_date": "2026-05-16",
  "cost": 89.99,
  "notes": "Synthetic 5W-30"
}'
```

## Verified end-to-end

Tested at the hackathon with a simulated BMW (VIN `3SC1134B1XMXS04E7`, 2026, ICE, 48,735 mi):

- ✅ M2M Bearer auth at `iam.smartcar.com`
- ✅ V3 `/connections` returns the simulator vehicle
- ✅ V3 `/signals` returns 54 fields (odometer, fuel, oil life, location, tires, diagnostics, service-records)
- ✅ All 7 syncs HEALTHY, data populated in Notion
- ✅ Health derivation: built-in 2023 oil-change record at 28,107 mi feeds into "last service mileage" for the oil rule
- ✅ Tools return correct projections — `overall_health: red` (some items DUE at current 48k mi vs. 30k air filter / 60k spark plug intervals)
- ✅ `canIMakeIt 380` correctly reports short by 177 mi for an LA-style trip
- ✅ Dashboard page live in Notion with links to all 7 databases

## Known limits

- **Tire pressure units**: Smartcar simulator returns small numbers (32, 35) labeled kPa. Real BMWs report 220–250 kPa. Alert thresholds (220 kPa) work correctly with real data; the simulator's labels are just inconsistent.
- **lockCar / unlockCar tools removed**: Smartcar V3 command paths for vehicle actions need further research; can be reinstated.
- **Webhook VERIFY**: Smartcar's webhook handshake requires returning `{challenge: HMAC(amt, challenge_string)}`. Notion Workers' `worker.webhook` can't customize the response body — the framework auto-returns `{eventId}`. Fix path: deploy a tiny Cloudflare Worker proxy that handles VERIFY then forwards normal events to the Notion webhook URL.

## Files

```
src/
  index.ts        ← Worker (7 syncs + 4 tools + 1 webhook + 1 pacer)
  smartcar.ts     ← Smartcar V3 client: M2M auth, /v3/connections, /v3/vehicles/{id}/signals → typed Snapshot
  maintenance.ts  ← BMW rule definitions + projectMaintenance + findLatestServiceForRule + aggregateHealth
cf-webhook-proxy/  ← Cloudflare Worker that handles Smartcar VERIFY (HMAC) and forwards events to Notion
scripts/
  connect-simulator.ts  ← Playwright Connect-flow automation (legacy fallback)
```

## Why CF Worker (not Railway) for the webhook proxy

The whole stack runs on Notion's serverless platform — no servers, no infra. The one piece that needs an external HTTP endpoint is Smartcar's webhook VERIFY handshake (Notion Workers can't return custom response bodies). For that, Cloudflare Workers is free, edge-runtime, ~30 lines, and matches the no-infra ethos. Railway would be a $5/mo always-on container massively over-provisioned for ~1 verification request and an occasional event.
