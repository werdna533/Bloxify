# Roblox × Shopify AI Commerce Lab — Build Spec

> Drop this in the repo root as `BUILD_SPEC.md` (or rename to `CLAUDE.md`). It's written for Claude Code to work from and for you to follow during the hackathon.

---

## 0. The pitch (say this in 20 seconds)

We put a Shopify store inside a Roblox world. We record what players actually do around the products — where they walk, what they look at, what they touch, what they buy. An AI reads that behaviour, forms a hypothesis, and then **rebuilds the storefront inside Roblox Studio itself** through the Studio MCP server. Then it playtests the new layout and shows you the before/after.

**Observe → Understand → Change → Test → Observe.**

---

## 1. The single most important correction to the original plan

The original brief assumed Roblox Studio MCP was a separate Rust server you install, with two tools (`run_code`, `insert_model`), driven by Claude Desktop.

**That's out of date.** The MCP server is now **built into Roblox Studio**. You turn it on in Assistant → ⋯ → Manage MCP Servers → "Enable Studio as MCP server", then quick-connect your client. **Claude Code is a supported quick-connect client.**

It exposes far more than `run_code`. The ones that matter for us:

| Tool | Why we care |
|---|---|
| `execute_luau` | Runs Luau in Studio. Takes a `datamodel_type`: `Edit`, `Client`, or `Server`. **This is our apply mechanism.** |
| `search_game_tree` | Reads the instance hierarchy as JSON. We use it to build the component registry. |
| `inspect_instance` | Properties + attributes of one instance. |
| `script_read` / `multi_edit` / `script_grep` | Read and write scripts in the place. |
| `start_stop_play` | Start/stop playtest. |
| `character_navigation` | Walk the player character to a position or instance. **This is our automated playtest bot.** |
| `user_mouse_input` / `user_keyboard_input` | Simulate clicks/keys, can target specific instances. |
| `screen_capture` | Screenshot the viewport, optionally from a custom camera position. **This is our before/after image.** |
| `get_console_output` | Read Studio output — how we get errors back. |
| `list_roblox_studios` | Lists connected Studio instances and their IDs. |

Every tool call takes a `studio_id`. Call `list_roblox_studios` first, cache the ID.

### What this means architecturally

The server talks **stdio** — standard input/output on a local process. So:

- ❌ Your web backend **cannot** open an HTTP connection to Studio MCP.
- ✅ A **local Node process on your laptop** can spawn the MCP binary and speak MCP to it.

So we build a small local program — call it the **Bridge** — that is an MCP client. It polls your backend for approved change plans and applies them. The dashboard's "Apply to Roblox" button then works end to end, because the Bridge is running on the same machine as Studio.

This is better than the original "Claude Desktop does it manually" idea: it's one click from your own UI, and it's your own code, which is much better to talk about with judges.

**Connection commands** (you'll need these for both Claude Code and the Bridge):

- macOS: `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`
- Windows: `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat`

---

## 2. Architecture

```
                 ┌──────────────┐
                 │   Shopify    │  products, orders webhook
                 └──────┬───────┘
                        │ Admin GraphQL API
                        ▼
  Roblox ──HTTPS──▶ Backend (Next.js + SQLite) ◀──── Dashboard (same app)
  runtime            │        ▲                          │
  (telemetry)        │        │ poll for pending plans   │ "Analyze" / "Apply"
                     │        │                          ▼
                     │    ┌───┴──────────┐            LLM (structured JSON)
                     │    │   Bridge     │               │
                     │    │ (local Node, │◀──────────────┘ validated plan
                     │    │  MCP client) │
                     │    └───┬──────────┘
                     │        │ stdio MCP
                     │        ▼
                     │   Roblox Studio  ──▶ execute_luau ▶ StorefrontAPI.apply()
                     │        │
                     └────────┘  playtest telemetry flows back
```

Two Roblox integrations, kept strictly separate (the original brief got this right):

- **Runtime**: game → HTTPS → backend. Collecting behaviour.
- **Edit time**: Bridge → MCP → Studio. Changing the world.

---

## 3. Repo layout

```
/
├── BUILD_SPEC.md          ← this file
├── app/                   Next.js 15 app (dashboard + API routes)
│   ├── app/
│   │   ├── api/
│   │   │   ├── events/route.ts           POST  telemetry ingest
│   │   │   ├── analytics/route.ts        GET   aggregated metrics
│   │   │   ├── products/route.ts         GET   products + shopify data
│   │   │   ├── experiments/route.ts      GET/POST
│   │   │   ├── experiments/[id]/apply/route.ts   POST  queue plan for bridge
│   │   │   ├── bridge/next/route.ts      GET   bridge polls this
│   │   │   ├── bridge/result/route.ts    POST  bridge reports back
│   │   │   ├── insights/route.ts         POST  run the LLM
│   │   │   └── shopify/webhook/route.ts  POST  orders/create
│   │   └── (dashboard pages)
│   ├── lib/
│   │   ├── db.ts          better-sqlite3
│   │   ├── metrics.ts     aggregation queries
│   │   ├── ai.ts          provider abstraction + structured output
│   │   ├── plan-schema.ts zod schema for change plans
│   │   ├── validate.ts    plan validation against live registry
│   │   └── shopify.ts     Admin GraphQL client
│   └── scripts/
│       └── simulate.ts    ← generates realistic synthetic sessions (CRITICAL)
├── bridge/                local MCP client
│   ├── index.ts           poll loop
│   ├── mcp.ts             stdio client wrapper
│   └── luau/apply.lua.ts  the Luau snippet we send
└── roblox/                Rojo project
    ├── default.project.json
    └── src/
        ├── ServerScriptService/
        │   ├── Telemetry/          batching + HTTP sender
        │   ├── Storefront/
        │   │   ├── StorefrontAPI.lua   ← the safe op surface
        │   │   └── Registry.lua
        │   └── Tracking/           proximity, attention, paths
        ├── ReplicatedStorage/Shared/
        └── StarterPlayer/StarterPlayerScripts/
```

**Source-of-truth rule, so Rojo and MCP don't fight:**

- **Code** (all `.lua`) lives in files. Rojo syncs files → Studio. Claude Code edits files.
- **The world** (parts, models, slot anchors, positions) lives in the `.rbxl` place file. MCP modifies that. Rojo never touches `Workspace`.

Keep `default.project.json` scoped to `ServerScriptService`, `ReplicatedStorage`, and `StarterPlayer` only. If Rojo turns into a time sink in the first 30 minutes, drop it and use the MCP `multi_edit` tool to write scripts instead. Don't burn an hour on it.

---

## 4. The slot system (read this — it's the biggest de-risking decision)

Do **not** let the AI emit raw XYZ coordinates in v1. Instead, place named anchor slots in the store by hand:

```
Slot_A ... Slot_H    -- empty Parts, invisible, anchored
```

Each slot has attributes you set once:

```
slotId       = "Slot_A"
trafficRank  = 1          -- 1 = busiest corridor, 8 = dead corner
facing       = Vector3    -- which way a display at this slot should point
```

Every storefront component has attributes:

```
componentId  = "display_ceramic_mug"
productId    = "gid://shopify/Product/123"
slotId       = "Slot_C"   -- current slot
kind         = "ProductStand" | "ProductWall" | "InteractiveDisplay" | ...
```

Then the AI's move operation is `move_to_slot(componentId, slotId)`, and:

- It can't put a product inside a wall.
- It can't overlap two displays (swap them if the slot is taken).
- Rotation is solved for free — snap to the slot's `facing`.
- The dashboard can show a clean top-down map of 8 slots.
- Validation is a one-line check: does the slot exist?

Raw coordinates are a Tier 3 stretch. Slots get you 95% of the demo with 5% of the failure modes.

---

## 5. Roblox side

### 5.1 Finding components

Use `CollectionService` tags, not name paths:

```lua
CollectionService:GetTagged("StorefrontComponent")
CollectionService:GetTagged("StorefrontSlot")
```

Names break when things get duplicated. Tags + attributes don't.

### 5.2 Events to collect

**Two surfaces, tracked separately.** A product exists in two places: the **physical display** standing in the world, and the **2D GUI panel** the player opens from it. These are different stages of intent and their time metrics mean completely different things. Never merge them into one "time spent" number.

| Surface | What time there means |
|---|---|
| Physical display | Ambient exposure. Cheap. A player can stand near something while looking elsewhere. |
| GUI panel | Deliberate consideration. Expensive. They chose to open it and chose to keep it open. |

#### Tier 1 — build these first

**Physical display**

| Event | When | Carries |
|---|---|---|
| `display_approach` | Player enters 12 studs | `fromSlot`, `approachBearing` (degrees off the display's facing), `entrySpeed` |
| `display_dwell` | On leaving the 12-stud radius | `dwellSeconds`, `minDistance`, `minSpeed`, `hadLineOfSight` |
| `display_gaze` | Camera aimed at it (dot > 0.85), unobstructed, within 20 studs, ≥0.75s. Emitted when gaze breaks | `gazeSeconds`, `distance` |
| `display_interacted` | ProximityPrompt triggered | `holdSeconds` |

**GUI panel**

| Event | When | Carries |
|---|---|---|
| `panel_opened` | Panel appears | `openMethod` ("prompt" / "click") |
| `panel_engaged` | Any action inside the panel | `action` ("variant_select", "image_next", "scroll", "tab") |
| `panel_cta_clicked` | Buy/claim button pressed | — |
| `panel_closed` | Panel dismissed | `openSeconds`, `activeSeconds`, `closeReason` ("manual", "walked_away", "idle_timeout") |

**Session and space**

| Event | When | Carries |
|---|---|---|
| `session_started` / `session_ended` | Join / leave | `durationSeconds` on end |
| `path_point` | Sampled position, only when moved >2 studs | `pos`, `look` |
| `shopify_link_shown` | Claim code / QR displayed | `claimCode` |

Use **ProximityPrompt** for physical interaction. It's built in, has a hold-to-activate UI, fires server-side, and costs ten minutes instead of two hours of ClickDetector plumbing.

#### Tier 2 — the genuinely Roblox-only signals

These are what make the data something a web analytics pixel structurally cannot produce. Add them once Tier 1 is flowing.

| Event | When | Why it's worth it |
|---|---|---|
| `display_impression` | Display is inside the camera frustum, unobstructed, >20 studs away (i.e. not an approach), for ≥0.5s. Client-side, debounced to once per display per 30s | Separates **"never saw it"** from **"saw it and walked past"**. That single distinction tells the AI whether the fix is placement or presentation. Nothing in 2D commerce has an equivalent. |
| `display_revisit` | Player returns to a display after visiting at least one other | Comparison shopping. In a web store this is a browser-back event; here it's a physical walk back across the room, which is a much costlier and therefore much stronger signal. |
| `display_hesitation` | Speed drops below 8 studs/s inside the radius, with gaze on the display, but no interaction before leaving | They slowed down to look and still didn't touch it. Almost pure "interested but not convinced". |

#### The funnel this gives you

```
impression  →  approach  →  gaze  →  interact  →  panel open  →  CTA  →  purchase
  (saw it)    (walked to)  (looked)  (touched)    (wanted more)  (wanted it)
```

Seven stages, where a normal store has about three. Each drop-off maps to a different fix, and the AI's job is to name which drop-off is the problem and pick the op that addresses it:

| Drop-off | Likely cause | AI's move |
|---|---|---|
| Low impressions | Bad placement / blocked sightline | `move_to_slot` to a higher `trafficRank` slot |
| Impressions but no approaches | Doesn't look interesting from a distance | `set_prominence`, `set_kind` to a larger display |
| Approaches but no gaze | Facing the wrong way | `move_to_slot` (snaps to slot facing) |
| Gaze but no interaction | No visible affordance | `enable_interaction`, `set_cta_text` |
| Interaction but no panel time | Panel content is weak | Not fixable by layout — flag it as a merchandising note |
| Panel time but no CTA | Price or product mismatch | Flag to the merchant, don't guess |

#### Three time metrics, never summed

- **dwell seconds** — near it. Weak signal.
- **gaze seconds** — looking at it. Medium signal.
- **panel active seconds** — GUI open *and* the player did something in the last 15s. Strong signal.

`activeSeconds` vs `openSeconds` matters: a player can open a panel and wander off. Track both, use `activeSeconds` for anything the AI reasons about.

#### Implementation notes for these

- **Camera direction is client-side only.** The server knows where the character faces, not where the camera points, and in Roblox those differ constantly. Gaze and impression must be computed in a LocalScript and sent to the server via RemoteEvent. Sample at 4Hz, not every frame.
- **Line of sight needs a raycast.** Proximity alone lies — a player can be 5 studs from a display with a wall between them. Raycast from camera to display, ignore the player's own character. Only run it for displays already inside the radius/frustum, at 4Hz. Cheap.
- **Debounce everything.** Gaze that flickers on and off as the camera wobbles will flood your backend. Require ≥0.75s continuous before emitting, and a 0.5s grace period before counting it as broken.
- **Trust the client loosely.** Client-reported gaze can be spoofed. For a hackathon this does not matter, but clamp the values server-side (no 400-second gaze events) so one bad message can't wreck your averages on stage.
- **Idle timeout.** If no input for 60s, end the current dwell/gaze/panel timers. AFK players will otherwise produce a single 20-minute "attention" event that destroys every average in your dashboard.

#### Deliberately not tracking yet

Note these in the README as "next" — it shows you chose, rather than missed:

- Other players nearby (social proof / crowding effects) — real and interesting in a multiplayer world, but it needs multiple simultaneous players to mean anything
- Full traversal order as a sequence model
- Where in the room players were when they quit
- Emote / avatar behaviour near products

### 5.3 Event envelope

```json
{
  "sessionId": "uuid-v4-generated-server-side",
  "placeVersion": 3,
  "experimentId": "exp_04",
  "events": [
    {
      "t": 1758300000.123,
      "type": "display_gaze",
      "surface": "physical",
      "componentId": "display_ceramic_mug",
      "productId": "gid://shopify/Product/123",
      "pos": [12.0, 3.5, -4.2],
      "look": [0.0, 0.0, -1.0],
      "meta": { "gazeSeconds": 7.2, "distance": 4.2 }
    }
  ]
}
```

`sessionId` is a random UUID made server-side per player per join. **Do not send Roblox UserIds or usernames.** You don't need them, and "we deliberately don't collect player identity" is a good line for judges.

`experimentId` is what makes the before/after comparison possible. Every event is stamped with which storefront configuration was live. Get this in from the very first line of telemetry code — retrofitting it at hour 25 is miserable.

### 5.4 Sending it

- `HttpService` **only works from the server**. Client scripts fire a `RemoteEvent`; the server batches.
- Batch: flush every **3 seconds** or **50 events**, whichever first. HttpService is limited to roughly 500 requests/minute per server — one request per event will get you throttled fast.
- `HttpService:RequestAsync` with a `Bearer` token header. Put the token in a ModuleScript that's gitignored, or just hardcode a dev token and don't publish.
- Wrap every call in `pcall`. A dead backend must never break the game during the demo.
- Drop events on the floor if the queue exceeds ~500. Never grow unbounded.

---

## 6. `StorefrontAPI.lua` — the safe operation surface

This module lives in `ServerScriptService/Storefront/`. It is the **only** thing MCP ever calls. The AI never writes Luau.

```lua
StorefrontAPI.apply(planJson) --> resultJson
```

Supported operations (v1):

| Op | Params | Effect |
|---|---|---|
| `move_to_slot` | componentId, slotId | Move component to slot, snap to slot facing. If occupied, swap the two. |
| `set_kind` | componentId, kind | Swap the component model for another from the prebuilt library |
| `set_prominence` | componentId, level 1–3 | Scale (1.0 / 1.25 / 1.5), spotlight on/off, accent colour |
| `enable_interaction` | componentId | Add/enable the ProximityPrompt |
| `disable_interaction` | componentId | Disable it |
| `set_cta_text` | componentId, text (≤40 chars) | Update the SurfaceGui CTA |
| `set_signage` | componentId, text (≤60 chars) | Update the header text |
| `swap_products` | componentIdA, componentIdB | Exchange which product sits on each |

Also required:

```lua
StorefrontAPI.snapshot()      --> full JSON state of every component
StorefrontAPI.restore(json)   --> put everything back
StorefrontAPI.registry()      --> componentIds, slotIds, kinds, current state
```

`snapshot` / `restore` is your rollback. Take a snapshot **before** every apply and store it on the experiment row. If a demo goes sideways you restore in one click.

Wrap the apply in `ChangeHistoryService:TryBeginRecording` / `FinishRecording` so Ctrl+Z also works in Studio.

Return a structured result:

```json
{ "ok": true, "applied": ["move_to_slot", "set_prominence"], "rejected": [], "errors": [] }
```

Partial failure is fine. Never let one bad op abort the whole apply silently.

---

## 7. The Bridge (local MCP client)

Node + TypeScript + `@modelcontextprotocol/sdk`.

```
1. Spawn the Studio MCP binary over stdio.
2. list_roblox_studios → cache studio_id.
3. Loop every 2s: GET /api/bridge/next
4. If a plan is pending:
   a. execute_luau (datamodel_type: "Edit"):
        require(...StorefrontAPI).snapshot()      → POST snapshot to backend
   b. execute_luau (Edit): StorefrontAPI.apply(planJson)
   c. screen_capture from the fixed demo camera → POST as "after" image
   d. POST result to /api/bridge/result
5. Optional (Tier 2): start_stop_play, character_navigation around the
   store, user_mouse_input on the prompts, start_stop_play off.
```

**Two traps here:**

1. **`datamodel_type` matters enormously.** Changes made in `Server`/`Client` (i.e. during a playtest) are **thrown away when play stops.** All storefront edits must be `Edit`. Use `get_studio_state` to confirm you're not in play mode before applying.
2. **String escaping.** You're sending Luau source that embeds a JSON string. Use a Luau long-bracket literal with a delimiter the JSON can't contain:

```lua
local plan = [==[{"ops":[...]}]==]
return require(game.ServerScriptService.Storefront.StorefrontAPI).apply(plan)
```

If `require` misbehaves from the Edit command-bar context, fall back to having the Bridge inline the whole module source before the call. Test this in POC 3, not at hour 26.

---

## 8. Backend

**Stack:** Next.js (App Router) + `better-sqlite3`. One process serves the API and the dashboard. SQLite is plenty — you'll have maybe 100k rows.

### Tables

```sql
products(id, shopify_id, title, price, image_url, url, component_id)
sessions(id, started_at, ended_at, experiment_id, place_version)
events(id, session_id, ts, type, component_id, product_id,
       x, y, z, lx, ly, lz, meta_json, experiment_id)
experiments(id, name, hypothesis, status, created_at,
            snapshot_before_json, plan_json, result_json,
            image_before, image_after)
orders(id, shopify_order_id, session_id, product_id, total, created_at)
```

Index `events(experiment_id, component_id, type)`. That one index carries every dashboard query.

### Metrics (define these once, in `metrics.ts`, and never redefine them)

Per product, per experiment. Add a `surface` column (`physical` | `gui`) to the events table so these split cleanly.

- **impressions** — distinct sessions with a `display_impression` (Tier 2)
- **approaches** — distinct sessions with a `display_approach`
- **dwell seconds** — sum of `display_dwell.dwellSeconds`
- **gaze seconds** — sum of `display_gaze.gazeSeconds`
- **interactions** — count of `display_interacted`
- **panel opens**, **panel active seconds**, **CTA clicks**, **link shows**, **purchases**

Rates (each answers a different question — compute all of them):

- **sightline rate** = approaches / impressions → is it a placement problem?
- **engagement rate** = interactions / approaches → is it a presentation problem?
- **depth rate** = panel opens / interactions → is the physical display overpromising?
- **intent rate** = CTA clicks / panel opens → is the product itself the problem?
- **conversion** = purchases / CTA clicks

Full funnel: `impression → approach → gaze → interact → panel → CTA → purchase`.

Also compute **approach concordance** — the share of approaches arriving within 60° of the display's facing direction. Low concordance with high dwell means people are walking up behind the thing, which `move_to_slot` fixes for free.

Spatial: a 2D grid histogram of `path_point` positions (bucket to 2-stud cells) → that's your heatmap, computed in about fifteen lines of SQL.

### `scripts/simulate.ts` — build this early

A script that POSTs realistic synthetic sessions to `/api/events`: players entering, walking a plausible path, lingering near some products more than others, interacting at a believable rate. Parameterised so you can say "Slot_A converts 3× better than Slot_G" and the data reflects it.

**Why this matters more than it sounds:** you cannot personally generate 3,000 encounters by walking around. Without a simulator your dashboard is empty until hour 28 and you can't test the AI layer at all. With one, everything downstream is unblocked from hour 6.

Label it honestly in the demo — "seeded with simulated traffic, plus live sessions from the playtest you just watched". Judges are fine with that. They are not fine with invented numbers presented as real.

---

## 9. AI layer

### Context you send (small, structured, never raw rows)

```json
{
  "store": { "slots": [{"slotId":"Slot_A","trafficRank":1}, ...] },
  "components": [
    { "componentId":"display_ceramic_mug", "productId":"...", "title":"Ceramic Mug",
      "price":24.00, "slotId":"Slot_C", "kind":"ProductStand",
      "prominence":1, "interactionEnabled":false }
  ],
  "metrics": [
    { "componentId":"display_ceramic_mug",
      "impressions":5100, "approaches":3421, "dwellSeconds":41200, "gazeSeconds":28700,
      "interactions":417, "panelOpens":180, "panelActiveSeconds":2160,
      "ctaClicks":83, "purchases":11,
      "sightlineRate":0.67, "engagementRate":0.12, "depthRate":0.43, "intentRate":0.46,
      "dominantApproachSlot":"Slot_A", "approachConcordance":0.31,
      "avgInteractionDistance":4.2, "hesitations":290 }
  ],
  "previousExperiments": [ { "id":"exp_03", "changes":[...], "deltaInteractionRate":+0.04 } ]
}
```

That `previousExperiments` field is what turns this from a one-shot suggestion into a learning loop. Include it from the start even when it's empty.

### Output: strict JSON schema

```json
{
  "hypothesis": "string",
  "evidence": ["string"],
  "confidence": "low" | "medium" | "high",
  "expectedEffect": "string",
  "ops": [ { "op": "move_to_slot", "componentId": "...", "slotId": "..." } ]
}
```

Use structured outputs / JSON schema mode (OpenAI `response_format`). Parse with zod. Single-provider decision for this build: OpenAI only, no fallback provider configured. Still keep the call behind a small `lib/ai.ts` wrapper rather than calling the SDK inline — costs nothing extra now and means there's one place to add a second provider later if OpenAI rate-limits during the demo.

### Validation before anything touches Roblox

Reject the plan if:

- any `componentId` or `slotId` isn't in the live registry pulled from Studio
- more than 5 ops
- two ops target the same component with conflicting intent
- CTA/signage text over the length cap, or contains anything you wouldn't put on screen
- `prominence` outside 1–3

Show rejections in the UI. "The AI proposed this, the validator refused it, here's why" is a genuinely strong thing to show a judge — it demonstrates you thought about safety rather than piping model output straight into a live environment.

### Language discipline

The AI describes **observed patterns**, never proven causes. "Players who approach from the main corridor interact more often" — not "moving this product will increase sales by 30%." Bake this into the system prompt. Overclaiming is the fastest way to lose a technical judge.

---

## 10. Shopify

### Minimum viable, do it this way

1. Shopify Partner account → create a **development store**.
2. In the store admin: Settings → Apps → **Develop apps** → create an app → grant `read_products`, `read_orders` → install → copy the **Admin API access token** (`shpat_...`).
3. Use that token with the Admin GraphQL API.

**Do not build OAuth.** A public app OAuth flow is a multi-hour detour that adds nothing a judge can see. A custom-app token is the same API with none of the ceremony.

4. Create 5 products with images and real-ish prices.
5. `GET /api/products` pulls them, caches locally, and maps each to a `componentId`.
6. In Roblox, the product panel shows title, price, and image (use the Shopify CDN image URL as a Decal — or pre-upload the 5 images as Roblox assets to avoid runtime image loading issues).

### Attribution (this is the part worth building)

Roblox can't run a web checkout in-game. So close the loop with a **claim code**:

- On `shopify_link_shown`, the backend mints a unique single-use discount code tied to the `sessionId` (Admin API `discountCodeBasicCreate`, e.g. 5% off).
- The in-game panel displays the code and a short URL.
- Player buys on their phone using that code.
- Your `orders/create` webhook fires, the payload carries the discount code → you now have a **real purchase attributed to a specific in-game session**.

That's genuine Roblox→Shopify attribution, not a hand-wave. It is the strongest single Shopify-track argument in the whole project.

**Tier 2 version:** render the URL as a scannable QR by having the backend return a 25×25 boolean matrix and drawing it as Frames in a SurfaceGui. About 40 lines of Luau, no asset uploads, and it makes the demo tactile — you pull out your phone, scan the wall in a Roblox game, and a real Shopify checkout opens.

**Webhooks need a public URL** — same tunnel as everything else (below). Use `orders/create`. Verify the HMAC.

---

## 11. Dashboard

Five screens, in priority order. Do not add a sixth.

1. **Store overview** — top-down 2D map (SVG or canvas) with the 8 slots, current component in each, heatmap overlay from path points.
2. **Product table** — the funnel per product, sortable.
3. **Experiment view** — hypothesis, evidence, ops list, before/after Studio screenshots side by side, delta metrics.
4. **Analyze** button → calls the LLM → shows the plan + validation results.
5. **Apply to Roblox** button → queues the plan for the Bridge, shows live status (`queued → applying → captured → done`).

The visual language should be a lab notebook, not a SaaS dashboard: EXPERIMENT #04, Hypothesis, Evidence, Intervention, Result. That framing is free differentiation and takes zero extra engineering.

Use one component library, don't design from scratch, don't spend more than 3 hours total on CSS.

---

## 12. Gotchas, in the order you'll hit them

| # | Bump | Fix |
|---|---|---|
| 1 | HTTP requests fail in Studio | Game Settings → Security → **Allow HTTP Requests** = on. Per place. |
| 2 | Roblox can't reach `localhost` | Try it first; if it fails, run `cloudflared tunnel --url http://localhost:3000` or ngrok. **You need a tunnel anyway for the Shopify webhook**, so just set it up at hour 0. |
| 3 | Tunnel URL changes on restart | Put the base URL in one Luau ModuleScript constant. Changing it should be a one-line edit. |
| 4 | `HttpService` from a LocalScript does nothing | It's server-only. RemoteEvent → server → HTTP. |
| 5 | HttpService throttling | Batch. 3s / 50 events. |
| 6 | MCP changes vanish after playtest | `datamodel_type: "Edit"`. Check `get_studio_state` first. |
| 7 | Studio MCP disconnects | It dies when Studio closes or the place changes. Bridge should re-handshake on every error, and log clearly. Don't debug this at hour 30. |
| 8 | `require` fails from the Edit command bar | Fallback: inline the module source into the `execute_luau` payload. Prove it works in POC 3. |
| 9 | Rojo overwrites the storefront | Scope `default.project.json` to script services only. Never map `Workspace`. |
| 10 | LLM invents component IDs | Validate against the live registry. Always. |
| 11 | Not enough real telemetry | The simulator. Build it at hour 6, not hour 28. |
| 12 | Shopify OAuth rabbit hole | Custom app token. Skip OAuth entirely. |
| 13 | Shopify test orders | Enable **Bogus Gateway** in the dev store payment settings so you can place real-looking test orders on camera. |
| 14 | 3D visualisation eats a day | 2D top-down only. The 3D view is literally Roblox — use `screen_capture`. |
| 15 | Demo needs a clean state | `StorefrontAPI.restore(snapshot)` + a saved `demo_baseline.rbxl`. Reset in one click between run-throughs. |
| 16 | Solo, 32 hours, no sleep | You have ~24 useful hours. Plan for 24, treat the rest as buffer. |

---

## 13. Do these three POCs before anything else (hour 0–2)

**POC 1 — Roblox → backend.** A part with a ProximityPrompt. Trigger it, see a row land in SQLite. Proves HttpService, the tunnel, and the auth header.

**POC 2 — backend → dashboard.** A page that shows the count of rows, auto-refreshing. Proves the read path.

**POC 3 — MCP → Studio.** Connect Claude Code to Studio MCP. Ask it to move a tagged part to a named slot via `execute_luau` in `Edit` mode. Watch it move in the viewport. Then do the same call from a 30-line Node script over stdio.

**POC 3 is the one that decides the project.** If the Node stdio client works, you build the full one-click loop. If it doesn't within 90 minutes, drop to Fallback 1 (section 15) and move on immediately. Do not spend three hours here.

---

## 14. Schedule (32h, solo)

| Hours | Work | Done when |
|---|---|---|
| 0–2 | Setup + the three POCs | All three green, or fallback chosen |
| 2–5 | Roblox: storefront, 8 slots, 5 components, ProximityPrompts, tags/attributes | You can walk around and trigger prompts |
| 5–9 | Telemetry module + backend ingest + **simulator** | Dashboard shows thousands of synthetic events |
| 9–12 | `StorefrontAPI` + Bridge + one-click apply | Clicking a button in a web page moves a product in Studio |
| 12–16 | Dashboard: map, funnel table, experiment view | Readable without explanation |
| 16–19 | AI: context builder, schema, validator | Analyze produces a valid plan from real metrics |
| 19–22 | Shopify: products in, claim codes, order webhook | A real test order appears attributed to a session |
| 22–25 | Before/after screenshots + auto-playtest bot | Experiment view shows two images and a delta |
| 25–28 | Polish, reset button, fallback paths, error states | Demo survives being run 3× in a row |
| 28–31 | Rehearse, **record a backup video**, README, diagram | You can do the pitch from memory |
| 31–32 | Buffer | — |

Note this front-loads MCP to hour 9–12 rather than the original hour 22–26. That was the highest-risk item sitting at the back of the schedule. Move it forward.

**Cut list, if you're behind:**

| If behind at | Cut |
|---|---|
| Hour 12 | Auto-playtest bot, QR rendering (claim code as text instead) |
| Hour 16 | Heatmap (keep slot map only), `previousExperiments` learning loop |
| Hour 20 | Shopify order webhook — use seeded orders, still show the product import |
| Hour 24 | Before/after screenshots — take them manually |
| Hour 26 | Everything except: telemetry → dashboard → AI plan → apply → visible change |

That last row is the demo. Protect it above all else.

---

## 15. Fallback ladder

- **Full:** dashboard button → backend → Bridge → MCP → Studio changes → screenshot back.
- **Fallback 1:** dashboard produces a validated plan JSON → you paste it into Claude Code with Studio MCP connected → it applies. Still a live AI-driven change to Roblox, just with you in the loop.
- **Fallback 2:** the plan is written to a file; a Studio plugin button reads it and calls `StorefrontAPI.apply`. No MCP at all. Works offline.
- **Fallback 3:** two saved place states (before/after), AI still generates the real analysis and plan live. The change is pre-baked.

Have Fallback 2 working by hour 26 regardless of whether the full path works. It costs about 30 minutes and removes all demo-day anxiety.

Record a screen capture of the full loop working the moment it first works. Do not wait until the end.

---

## 16. Who does what

### Only you can do these (do them at hour 0, they block everything)

- [ ] Install/update Roblox Studio, sign in
- [ ] Assistant → ⋯ → Manage MCP Servers → enable, quick-connect **Claude Code**
- [ ] Create the place; Game Settings → Security → **Allow HTTP Requests**
- [ ] Shopify Partner account → dev store → custom app → copy `shpat_` token → enable Bogus Gateway → create 5 products
- [x] Get an LLM API key — OpenAI only for this build. No second-provider backup key; if OpenAI rate-limits during the demo, there is no automatic failover.
- [ ] Install `cloudflared` or `ngrok`, start a tunnel, note the URL
- [ ] Register the Shopify `orders/create` webhook against the tunnel URL
- [ ] Devpost/submission account, repo created

### Only you can do these (ongoing)

- Anything requiring visual judgement in Studio: laying out the room, placing the 8 slots, making the 5 component models look decent
- Approving MCP actions when the client prompts
- Playing the game to generate real sessions
- Deciding what the demo story is and rehearsing the pitch
- Recording the backup video
- Judging "is this good enough to move on" — Claude Code will happily polish forever

### Claude Code can do essentially all of these

- Backend: schema, API routes, aggregation SQL, the whole Next.js app
- Dashboard: every screen, the SVG slot map, the heatmap
- **The simulator** — describe the behaviour you want, it'll write it
- All Luau: telemetry batching, proximity/attention tracking, `StorefrontAPI`, the component library builders
- The Bridge: MCP stdio client, poll loop, escaping, error handling
- AI layer: prompt, schema, provider abstraction, zod validator
- Shopify: GraphQL client, discount code minting, webhook HMAC verification
- README, architecture diagram, the Devpost writeup draft

### Claude Code can do these **because** it has Studio MCP

This is the part people miss — with MCP connected, Claude Code isn't limited to writing files:

- **Build the storefront for you.** "Create 8 slot anchors in a 40×40 room, tag them `StorefrontSlot`, set `trafficRank` by distance from spawn." One prompt, done in Studio.
- Generate the 5 component models (`generate_procedural_model` builds objects from primitives, `generate_mesh` from a text prompt)
- Tag and attribute every existing instance correctly
- Read the tree back (`search_game_tree`) to verify its own work
- Playtest and read console output to debug your Luau
- Take the before/after screenshots

**Practical rule:** let Claude Code do the structural Studio work (anchors, tags, attributes, positions, scripts). You do the aesthetic pass. That split saves you hours and plays to what each of you is fast at.

### Things to explicitly tell Claude Code *not* to do

- Don't add features not in this spec
- Don't refactor working code
- Don't write tests beyond a smoke test for the validator
- Don't touch `Workspace` via Rojo
- Don't spend time on CSS beyond making it legible

---

## 17. Optional: the Elastic track

If you're ahead at hour 20 (you probably won't be), the Elastic prize is a plausible second track: pipe raw events into Elasticsearch, use ES|QL for the aggregations instead of SQL, and give the AI an Agent Builder tool that queries ES to decide what to retrieve. Your data genuinely fits their brief — messy, high-volume, semi-structured behavioural streams.

But this replaces a working SQLite layer with an unfamiliar one. **Only do it if the core loop is fully demoable and rehearsed.** One prize won convincingly beats two attempted.

---

## 18. The test for every decision

> Does this make **Observe → Understand → Change → Test** more reliable to demonstrate?

If yes, build it. If it's merely impressive, it's a stretch goal. If it's impressive but fragile, it's a liability.
