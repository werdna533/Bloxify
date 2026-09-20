# Commerce Lab

**An AI merchandising agent for Shopify products inside Roblox.**

Commerce Lab observes how players move through a Roblox storefront, identifies
where the product funnel loses attention, proposes a storefront change, applies
it in Roblox Studio, and captures the result.

`Observe -> Understand -> Change -> Test`

## Features

- Live Roblox telemetry for physical displays and product panels.
- Seven-stage funnel: impression, approach, gaze, interaction, panel, CTA,
  purchase.
- Shopify product catalog and purchase attribution through claim codes.
- AI-generated merchandising hypotheses and structured change plans, aware of
  the actual Roblox game and room shape it's reasoning about, product price,
  and its own prior experiments — not just funnel numbers in isolation.
- Safety validation against the live Roblox registry.
- Freeform (x, z, facing) placement, validated against the room's region
  bounds, other displays, and real geometry collisions before anything moves.
- `swap_products`: trade two displays' positions to test whether a slot, not
  the product, explains a performance gap.
- One-click apply through Roblox Studio MCP, with before-apply snapshots,
  one-click rollback, and experiment record deletion for cleaning up history.
- Before/after screenshots stored in Cloudflare R2.
- Experiment state and job coordination with Cloudflare D1 and Durable Objects.
- Dashboard analytics, product funnel, a live 3D view of attention in the
  actual room (heat, sightlines, and hotspot/window-shopper/hidden-gem/
  dead-weight quadrants), and experiment comparison. The sidebar shows the
  connected Roblox game's own name and thumbnail, not a static logo.
- **Create Storefront**: a second Cloudflare agent that classifies your
  Shopify catalog into display types, computes a layout that clears the
  room's real geometry, and queues it for the Roblox place's own script to
  build — no MCP, no Studio session, works for a place you've never opened
  in this tool before.

## Tech stack

- **Roblox:** Luau, Studio MCP.
- **Frontend:** Next.js, React, TypeScript.
- **Agent backend:** Cloudflare Workers, D1, Durable Objects, R2.
- **Commerce:** Shopify Admin GraphQL API and orders webhook.
- **Local Bridge:** Node.js, TypeScript, Model Context Protocol SDK.
- **Tunnel:** Cloudflare Tunnel for Roblox and Shopify webhook access.

## Requirements

- Node.js 20 or newer.
- Roblox Studio with Studio MCP enabled.
- An MCP-compatible AI client for initial Roblox place setup, such as Claude
  Code. Use your own client subscription and credentials.
- `cloudflared`.
- Shopify development store and custom app credentials.
- Cloudflare account with Workers, D1, Durable Objects, and R2 access.
- Optional: a Roblox Open Cloud API key, only needed for **Create
  Storefront** to upload product/garment images automatically (see below).
  Without one, Create Storefront still builds the layout, just with
  placeholder art until you upload assets manually.

## Setup

### 1. Clone and install

```powershell
git clone <repository-url>
cd htn_26
cd app
npm install
cd ..\bridge
npm install
cd ..\worker
npm install
cd ..
```

### 2. Create the local environment file

Create one `.env.local` at the repository root. Do not create a second
`worker/.env` file.

```dotenv
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_TOKEN=your-shopify-admin-token
SHOPIFY_CLIENT_SECRET=your-shopify-client-secret
OPENAI_API_KEY=your-openai-key
BACKEND_AUTH_TOKEN=generate-a-random-shared-token
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
TUNNEL_URL=https://your-tunnel.trycloudflare.com
WORKER_URL=https://your-worker.workers.dev
BRIDGE_TARGET=https://your-worker.workers.dev

# Optional -- only needed for Create Storefront's automated asset upload.
# Roblox Creator Dashboard -> Open Cloud -> API Keys -> asset:read + asset:write.
# ROBLOX_API_KEY=your-open-cloud-api-key
# ROBLOX_CREATOR_ID=your-numeric-roblox-user-id
```

`.env.local` is gitignored. Never commit credentials.

### 3. Prepare Cloudflare

From `worker/`:

```powershell
npx wrangler d1 create htn-lab
npx wrangler r2 bucket create htn-lab-shots
```

Put the returned D1 database ID into `worker/wrangler.toml`, keeping the
bindings named `DB` and `SHOTS`. Then run:

```powershell
npm run migrate:remote
npx wrangler secret put BACKEND_AUTH_TOKEN
npx wrangler secret put OPENAI_API_KEY
npm run deploy
```

Set `WORKER_URL` and `BRIDGE_TARGET` to the deployed Worker URL.

### 4. Prepare Roblox Studio

1. Open the target Roblox place.
2. Enable **Game Settings -> Security -> Allow HTTP Requests**.
3. Enable **Assistant -> Manage MCP Servers -> Studio as MCP server**.
4. Connect your own MCP-compatible AI client to Studio MCP.
5. Create one Part covering the walkable floor area and tag it
   `StorefrontRegion` (this is the only physical layout step — placement
   itself is freeform `(x, z, facing)` from here, not hand-placed slots).
6. If displays already exist, tag them `StorefrontComponent` and give them
   `componentId`, `productId`, `title`, `price`, `kind`, and `prominence`
   attributes. **Starting from a blank place with no displays at all?** Skip
   this — that's what **Create Storefront** (step 7) is for.

The committed Roblox modules are reusable across places:

- `roblox/src/ServerScriptService/Storefront/ComponentLibrary.lua`
- `roblox/src/ServerScriptService/Storefront/StorefrontAPI.lua`
- `roblox/src/ServerScriptService/Telemetry/Telemetry.lua`
- `roblox/src/StarterPlayer/StarterPlayerScripts/ProductPanel.lua`

The `.server.lua` and `.client.lua` files are entrypoints that start these
modules, including `StorefrontSetup.server.lua` (polls the Worker for a
pending Create Storefront job and builds it — plain Luau, no MCP) and
`GeometryExport.server.lua` (captures the room shell for the dashboard's 3D
view and pushes it on server start — also plain Luau, no MCP; see step 6).
The AI only emits named operations; it never writes arbitrary Luau or raw
coordinates.

### 5. Start the local app and tunnel

Terminal 1:

```powershell
cd app
npm run dev
```

Terminal 2:

```powershell
cloudflared tunnel --url http://localhost:3000
```

Copy the printed `trycloudflare.com` URL into `TUNNEL_URL` in `.env.local`.
Keep this terminal open. Quick tunnel URLs change when the process restarts.

### 6. Sync Roblox and start the Bridge

Restart the terminal after editing `.env.local`, then run:

```powershell
cd bridge
npx tsx sync-config.ts
npx tsx push-scripts.ts
npx tsx pull-registry.ts
npx tsx index.ts
```

Room geometry for the dashboard's 3D view no longer needs a manual step: once
the place is running (Play, or in production), `GeometryExport.server.lua`
captures it from the `StorefrontRegion` part's bounds and pushes it on server
start automatically — no MCP session required at that point. If you're
actively reshaping the room and don't want to wait for the next server
restart, `npx tsx export-geometry.ts` still exists as a manual on-demand
re-sync, driven the same way as `pull-registry.ts` above.

Open the dashboard at `http://localhost:3000`, collect live Roblox sessions,
then use **Analyze -> Save as experiment -> Apply to Roblox**.

### 7. Create Storefront (optional, for a blank place)

If the Roblox place has no `StorefrontComponent`-tagged displays yet, the
dashboard shows a **Create Storefront** card instead of the usual analytics.
Clicking it:

1. Fetches your Shopify catalog.
2. Sends it to the Worker, which classifies each product (Mannequin, plush,
   generic stand, or wall poster) and lays them out as an evenly spaced row
   through the `StorefrontRegion` part, facing the region's own local +Z axis
   (rotate the region in Studio to change which way the row faces) —
   deterministic math, not an LLM guessing coordinates.
3. If `ROBLOX_API_KEY`/`ROBLOX_CREATOR_ID` are set, generates a garment
   texture for clothing items and uploads it plus the panel photo via
   Roblox's Open Cloud Assets API, no Studio session required. Without a
   key, the layout still queues; displays get the `ComponentLibrary` default
   look until you run the existing `bridge/` upload scripts once manually.
4. Queues the finished job. `StorefrontSetup.server.lua`, already running in
   the place from step 4, polls for it, builds each display, and validates
   its position the same way the AI's own `move_to_position` does.

This is the piece that makes the tool usable on a Roblox game you're opening
for the first time, not just this repo's own demo place. It requires the
Cloudflare Worker (`WORKER_URL` set) — there's no local-only equivalent,
since the point is a job queue a live Roblox server can poll without MCP.

## Cloudflare judging track

The deployed Worker is a meaningful part of the agent loop, not static hosting:

- **Workers:** planning, validation, experiment routes, storefront
  classification/layout, and orchestration.
- **Durable Objects:** one stateful run per experiment (`ExperimentRun`) and
  one singleton per place (`StorefrontSetup`), each serializing a claim so
  two pollers can never double-apply the same job.
- **D1:** experiment plans, snapshots, statuses, results, and registry state.
- **R2:** after-apply screenshots from Roblox Studio.

Two judging demonstrations:

`live Roblox behavior -> Worker plan -> validation -> Durable Object job -> Roblox change -> R2 result`

`blank Roblox place -> Worker classifies + lays out the Shopify catalog -> Durable Object job -> Roblox's own poller builds it, no MCP`

## Troubleshooting

- **Dashboard is empty:** collect live Roblox sessions and confirm the tunnel URL
  is current.
- **Roblox cannot reach the backend:** enable HTTP requests and check
  `TUNNEL_URL` in the synced Studio config.
- **Bridge cannot connect:** Studio must be open with Studio MCP enabled, and
  the Bridge must run on the same machine.
- **Changes disappear:** apply through Studio MCP in `Edit` mode, not during a
  playtest.
- **Apply/Roll back does nothing after clicking it — the experiment just sits
  "queued":** the Bridge (`npx tsx bridge/index.ts`) isn't running. Nothing
  else polls for queued experiments; unlike Create Storefront, this apply
  path is not self-serve and needs the Bridge process alive on a machine with
  Studio open in `Edit` mode.
- **Cloudflare auth fails:** verify the API token has Workers Scripts, D1, and
  R2 edit permissions for the correct account.
- **Rollback unavailable:** the Bridge must complete its pre-apply snapshot.
- **Worker routes intermittently 500 with `error code: 1101`:** check
  `wrangler tail` for the real exception before assuming a code bug. D1's
  free tier caps both daily row *writes* and, separately, daily row *reads*;
  either one exhausting mid-demo produces exactly this symptom on some
  requests but not others, resetting at 00:00 UTC (or fixed immediately by
  upgrading to Workers Paid). Don't seed bulk synthetic/demo data into D1 —
  reserve it for the agent's own state and use local SQLite
  (`WORKER_URL` unset) for large synthetic seeds.

## Repository layout

```text
app/       Next.js dashboard and local API
bridge/    Local MCP client and Studio sync tools
roblox/    Reusable Luau modules and Studio plugin
worker/    Cloudflare Worker, D1 migrations, Durable Object, and R2 handling
```
