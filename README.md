# Commerce Lab — Roblox × Shopify

A Shopify store inside a Roblox world. We record what players actually do
around the products — where they walk, what they look at, what they touch.
An AI reads that behaviour, forms a hypothesis, and **rebuilds the storefront
inside Roblox Studio itself**. Then you can see the change and roll it back.

**Observe → Understand → Change → Test → Observe.**

---

## Why the data is different

A web analytics pixel can tell you someone loaded a product page. It cannot
tell you that a player walked past a display six times without ever seeing it,
because there is no such thing as standing behind a shelf on a web page.

The funnel here has seven stages where a normal store has about three:

```
impression → approach → gaze → interact → panel open → CTA → purchase
 (saw it)   (walked to) (looked) (touched)  (wanted more) (wanted it)
```

Each drop-off points at a different fix, and the AI's job is to name which
drop-off is the problem rather than guess at a cause:

| Drop-off | Reading | The move |
|---|---|---|
| Few impressions | never seen — placement or blocked sightline | `move_to_slot` |
| Impressions, few approaches | uninteresting from a distance | `set_prominence`, `set_kind` |
| Approaches, little gaze | facing the wrong way | `move_to_slot` (snaps to slot facing) |
| Gaze, no interaction | no visible affordance | `enable_interaction`, `set_cta_text` |
| Interaction, no panel time | panel content is weak | flagged, not "fixed" by layout |
| Panel time, no CTA | price or product mismatch | flagged for the merchant |

Three time metrics are tracked and **never summed**: dwell (near it, weak),
gaze (looking at it, medium), and panel *active* seconds (panel open *and*
being used, strong).

No Roblox UserIds or usernames are collected. Sessions are random UUIDs.

---

## Architecture

```
                  ┌──────────────┐
                  │   Shopify    │ products, orders/create webhook
                  └──────┬───────┘
                         │ Admin GraphQL
                         ▼
   Roblox ──HTTPS──▶ Backend (Next.js + SQLite) ◀──── Dashboard (same app)
   runtime             │        ▲                          │
   (telemetry)         │        │ poll for approved plans  │ Analyze / Apply
                       │    ┌───┴──────────┐               ▼
                       │    │   Bridge     │◀───── LLM (structured JSON)
                       │    │ (local Node, │        + validator
                       │    │  MCP client) │
                       │    └───┬──────────┘
                       │        │ stdio MCP
                       │        ▼
                       │   Roblox Studio ──▶ StorefrontAPI.apply()
                       └────────┘
```

Two Roblox integrations, kept strictly separate:

- **Runtime** — the game POSTs telemetry over HTTPS. Collecting behaviour.
- **Edit time** — the Bridge drives Studio over MCP. Changing the world.

Studio's MCP server speaks **stdio**, so a web backend cannot reach it. The
Bridge is a local Node process that can, which is what makes "Apply to Roblox"
a single button instead of a manual copy-paste.

---

## Layout

```
app/                    Next.js app — API routes and dashboard
  app/api/              events, analytics, registry, insights,
                        experiments, bridge, products, claim, shopify/webhook
  lib/                  db, metrics, ai, plan-schema, validate, shopify
  scripts/simulate.ts   synthetic session generator
bridge/                 local MCP client
  index.ts              poll loop: snapshot → apply → capture → report
  mcp.ts                stdio MCP wrapper
  push-scripts.ts       syncs roblox/src into the place (used instead of Rojo)
  pull-registry.ts      pulls the live registry out of Studio
roblox/
  src/                  Luau: telemetry, tracking, StorefrontAPI, panels
  plugin/               Fallback 2 — applies a plan with no MCP at all
```

**Source-of-truth rule:** code lives in files under `roblox/src` and is pushed
into the place. The *world* — parts, slots, positions — lives in the place file
and is changed only through `StorefrontAPI`.

---

## The slot system

The AI never emits raw coordinates. The store has eight named anchor slots,
each with a `trafficRank` (1 = busiest corridor, 8 = dead corner) and a
`facing` direction. The only placement operation is
`move_to_slot(componentId, slotId)`, which means:

- nothing can be placed inside a wall
- two displays cannot overlap — occupying a taken slot swaps them
- rotation is solved for free by snapping to the slot's facing
- validation is a one-line check: does the slot exist?

Components are found by `CollectionService` tag, never by name path, so
duplicating or renaming things does not break tracking.

---

## `StorefrontAPI` — the only surface MCP touches

The AI never writes Luau. It emits a plan of named operations, and this module
decides whether each one is legal.

| Op | Effect |
|---|---|
| `move_to_slot` | move to a slot, snap to its facing, swap if occupied |
| `set_kind` | rebuild the display from the component library |
| `set_prominence` | scale 1.0 / 1.25 / 1.5, spotlight, accent colour |
| `enable_interaction` / `disable_interaction` | toggle the prompt |
| `set_cta_text` | CTA text, ≤40 chars |
| `set_signage` | header text, ≤60 chars |
| `swap_products` | exchange which product sits on which display |

Plus `snapshot()`, `restore(json)` and `registry()`. **Every apply takes a
snapshot first**, so any experiment is reversible in one call. Partial failure
is fine: one bad op is rejected with a reason and the rest still apply.

---

## Safety rails

- **The validator runs before anything reaches Roblox.** It rejects any op
  naming a component or slot that is not in the registry pulled live from
  Studio, more than five ops, contradictory ops on one component, over-length
  or unsafe text, and prominence outside 1–3. Rejections are shown in the UI
  with the reason — the model proposes, the validator decides.
- **The model is told to describe observed patterns, never proven causes**, and
  never to promise a percentage improvement.
- **Simulated and live data are never mixed silently.** Every event carries
  `source`, the dashboard labels counts as SEEDED SIMULATION or LIVE SESSION,
  and you can filter to either.
- **A dead backend cannot break the game.** Every HTTP call from Roblox is
  wrapped, the queue is capped, and events are dropped rather than growing
  unbounded.
- **Edits are refused while Studio is in play mode**, because changes made
  during a playtest are discarded when play stops.

---

## Running it

```bash
# 1. backend + dashboard
cd app && npm install && npm run dev        # http://localhost:3000

# 2. expose it (Roblox cannot reach localhost)
cloudflared tunnel --url http://localhost:3000
#    put the printed URL in .env.local as TUNNEL_URL

# 3. push config and code into the open Studio place
cd bridge && npm install
npx tsx sync-config.ts      # carries the backend URL + token into the place
npx tsx push-scripts.ts     # pushes roblox/src/**/*.lua
npx tsx pull-registry.ts    # pulls slots + components back out

# 4. seed some behaviour so the funnel has volume
cd ../app && npx tsx scripts/simulate.ts --sessions 400

# 5. run the Bridge, then press ANALYZE → SAVE → APPLY TO ROBLOX
cd ../bridge && npx tsx index.ts
```

`.env.local` at the repo root holds `SHOPIFY_STORE_DOMAIN`,
`SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_CLIENT_SECRET`, `OPENAI_API_KEY`,
`TUNNEL_URL` and `BACKEND_AUTH_TOKEN`. It is gitignored and must stay that way.

---

## Fallback ladder

The top tier works, but each rung below it is real and tested:

1. **Full** — dashboard button → backend → Bridge → MCP → Studio changes.
2. **Fallback 1** — the dashboard produces a validated plan; paste it into a
   Claude Code session connected to Studio MCP.
3. **Fallback 2** — the `roblox/plugin` Studio plugin applies a plan with no
   MCP and no Bridge, either fetched from the backend or pasted into
   `ServerStorage.PendingPlan`. Snapshots first, and can roll back.
4. **Fallback 3** — two saved place states, with the analysis still generated
   live.

---

## Deliberately not tracked yet

Chosen, not missed:

- other players nearby (social proof and crowding) — needs several
  simultaneous players to mean anything
- full traversal order as a sequence model
- where in the room players were when they quit
- emote and avatar behaviour near products
