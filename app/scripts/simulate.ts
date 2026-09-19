/**
 * Posts synthetic sessions to /api/events so the dashboard and the AI layer
 * have something to work with before thousands of real encounters exist.
 *
 * Everything it writes is tagged source="sim". Nothing here should ever be
 * presented as a live session.
 *
 *   npx tsx scripts/simulate.ts --sessions 400
 */
import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

const rootEnv = path.resolve(process.cwd(), "..", ".env.local");
if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv, quiet: true });

const BASE_URL = process.env.SIM_TARGET ?? "http://localhost:3000";
const AUTH_TOKEN = process.env.BACKEND_AUTH_TOKEN ?? "";

// How much a product is wanted, independent of where it is standing. This is
// the thing placement cannot change, so the AI has to separate it from traffic.
const APPEAL: Record<string, number> = {
  display_plush_goose: 0.55,
  display_rugby_shirt: 0.5,
  display_classic_tee: 0.42,
  display_crewneck: 0.36,
  display_sweatpants: 0.28,
};
const DEFAULT_APPEAL = 0.35;

const SPAWN: [number, number, number] = [-77, 5, 0];
const AISLE_X = -77;

type Registry = {
  experimentId: string;
  slots: { slotId: string; trafficRank: number; pos: number[]; facing: number[] }[];
  components: {
    componentId: string;
    productId: string;
    title: string;
    price: number;
    slotId: string;
    kind: string;
    prominence: number;
    interactionEnabled: boolean;
    pos: number[];
  }[];
};

type SimEvent = {
  t: number;
  type: string;
  surface?: "physical" | "gui";
  componentId?: string;
  productId?: string;
  pos?: number[];
  look?: number[];
  meta?: Record<string, unknown>;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const chance = (p: number) => Math.random() < p;

/** Skewed low, long tail — how attention time actually distributes. */
function lognormalish(median: number, spread: number): number {
  return median * Math.exp((Math.random() + Math.random() + Math.random() - 1.5) * spread);
}

function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function main() {
  const sessionCount = Number(process.argv[process.argv.indexOf("--sessions") + 1] || 400);

  const res = await fetch(`${BASE_URL}/api/registry`);
  if (!res.ok) {
    console.error(
      `[sim] no registry on the backend (HTTP ${res.status}). Run: npx tsx bridge/pull-registry.ts`,
    );
    process.exit(1);
  }
  const registry = (await res.json()) as Registry;
  const rankBySlot = new Map(registry.slots.map((s) => [s.slotId, s.trafficRank]));

  console.log(
    `[sim] ${sessionCount} sessions against ${registry.components.length} components, experiment ${registry.experimentId}`,
  );

  let posted = 0;
  let eventCount = 0;
  const startWall = Date.now() / 1000 - sessionCount * 9;

  for (let i = 0; i < sessionCount; i++) {
    const sessionId = uuid();
    const t0 = startWall + i * 9 + rand(0, 4);
    const events = buildSession(registry, rankBySlot, t0);
    eventCount += events.length;

    // Batch the way the game does, so the ingest path sees realistic shapes.
    for (let c = 0; c < events.length; c += 50) {
      const chunk = events.slice(c, c + 50);
      const response = await fetch(`${BASE_URL}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({
          sessionId,
          placeVersion: 1,
          experimentId: registry.experimentId,
          source: "sim",
          events: chunk,
        }),
      });
      if (!response.ok) {
        console.error(`[sim] ingest rejected batch: HTTP ${response.status} ${await response.text()}`);
        process.exit(1);
      }
    }
    posted++;
    if (posted % 50 === 0) console.log(`[sim]   ${posted}/${sessionCount} sessions`);
  }

  console.log(`[sim] done: ${posted} sessions, ${eventCount} events, all tagged source="sim"`);
}

function buildSession(registry: Registry, rankBySlot: Map<string, number>, t0: number): SimEvent[] {
  const events: SimEvent[] = [];
  let t = t0;
  let pos: number[] = [...SPAWN];
  const walkSpeed = rand(11, 17);

  // Players who lose interest turn back early, which is what makes a far slot
  // genuinely worse rather than uniformly worse.
  const patience = rand(0.35, 1.0);
  const walkDepth = 30 + patience * 90;

  const unit = (from: number[], to: number[]): number[] => {
    const dx = to[0] - from[0];
    const dz = to[2] - from[2];
    const len = Math.hypot(dx, dz) || 1;
    return [dx / len, 0, dz / len];
  };

  // Walks the player there for real, dropping path points on the way. A
  // heatmap is only meaningful if the trail is where a body actually went.
  const walkTo = (target: number[], lookAt?: number[]) => {
    const dist = Math.hypot(target[0] - pos[0], target[2] - pos[2]);
    const steps = Math.max(1, Math.round(dist / rand(2.2, 3.4)));
    for (let i = 1; i <= steps; i++) {
      const remaining = steps - i + 1;
      pos = [
        pos[0] + (target[0] - pos[0]) / remaining + rand(-0.6, 0.6),
        5,
        pos[2] + (target[2] - pos[2]) / remaining + rand(-0.6, 0.6),
      ];
      t += dist / steps / walkSpeed;
      events.push({ t, type: "path_point", pos: [...pos], look: unit(pos, lookAt ?? target) });
    }
  };

  events.push({ t, type: "session_started", pos: [...pos] });

  const inRange = registry.components
    .filter((c) => c.pos[2] <= walkDepth)
    .sort((a, b) => a.pos[2] - b.pos[2]);

  for (const component of inRange) {
    const rank = rankBySlot.get(component.slotId) ?? 8;
    const appeal = APPEAL[component.componentId] ?? DEFAULT_APPEAL;
    const prominenceBonus = (component.prominence - 1) * 0.08;

    // Stand-off point between the display and the aisle it faces.
    const side = component.pos[0] < AISLE_X ? 1 : -1;
    const standPoint = [component.pos[0] + side * rand(4, 6), 5, component.pos[2] + rand(-3, 3)];
    const aislePoint = [AISLE_X + rand(-7, 7), 5, component.pos[2] - rand(6, 14)];

    walkTo(aislePoint, component.pos);

    // Did they ever see it? The distinction a web pixel cannot make.
    if (!chance(clamp(1.02 - 0.085 * rank, 0.25, 0.97))) continue;

    events.push({
      t,
      type: "display_impression",
      surface: "physical",
      componentId: component.componentId,
      productId: component.productId,
      pos: [...pos],
      look: unit(pos, component.pos),
      meta: {
        distance: Number(
          Math.hypot(component.pos[0] - pos[0], component.pos[2] - pos[2]).toFixed(1),
        ),
      },
    });

    const pApproach = clamp(
      0.24 + 0.46 * appeal + 0.22 * (1 - rank / 8) + prominenceBonus,
      0.04,
      0.92,
    );
    if (!chance(pApproach)) continue;

    // They divert out of the aisle to the display. This detour is the shape a
    // traffic heatmap should actually show.
    walkTo(standPoint, component.pos);

    // Everything faces the aisle, so most approaches are head-on; the tail is
    // people cutting across from behind.
    const bearing = chance(0.82) ? rand(0, 55) : rand(95, 175);
    events.push({
      t,
      type: "display_approach",
      surface: "physical",
      componentId: component.componentId,
      productId: component.productId,
      pos: [...pos],
      look: unit(pos, component.pos),
      meta: {
        fromSlot: "aisle",
        approachBearing: Number(bearing.toFixed(1)),
        entrySpeed: Number(rand(8, 17).toFixed(1)),
      },
    });

    const dwell = clamp(lognormalish(4.5 + appeal * 7, 0.55), 1.2, 60);
    const minDistance = Number(
      Math.hypot(component.pos[0] - pos[0], component.pos[2] - pos[2]).toFixed(1),
    );
    const minSpeed = rand(0, 9);
    const sawIt = bearing < 90;

    let gazeSeconds = 0;
    if (chance(sawIt ? 0.82 : 0.22)) {
      gazeSeconds = clamp(lognormalish(1.8 + appeal * 4.5, 0.6), 0.75, 40);
      t += gazeSeconds;
      events.push({
        t,
        type: "display_gaze",
        surface: "physical",
        componentId: component.componentId,
        productId: component.productId,
        pos: [...pos],
        look: unit(pos, component.pos),
        meta: { gazeSeconds: Number(gazeSeconds.toFixed(2)), distance: minDistance },
      });
    }

    const pInteract = component.interactionEnabled
      ? clamp(0.18 + 0.52 * appeal + (gazeSeconds > 2 ? 0.14 : 0) + prominenceBonus, 0.02, 0.88)
      : 0.015;
    const interacted = gazeSeconds > 0 && chance(pInteract);

    // Slowed down, looked, still did not touch it: interested, unconvinced.
    if (!interacted && gazeSeconds > 1.2 && minSpeed < 8 && chance(0.55)) {
      events.push({
        t,
        type: "display_hesitation",
        surface: "physical",
        componentId: component.componentId,
        productId: component.productId,
        pos: [...pos],
        meta: { minSpeed: Number(minSpeed.toFixed(1)), gazeSeconds: Number(gazeSeconds.toFixed(2)) },
      });
    }

    if (interacted) {
      t += rand(0.4, 1.4);
      events.push({
        t,
        type: "display_interacted",
        surface: "physical",
        componentId: component.componentId,
        productId: component.productId,
        pos: [...pos],
        meta: { holdSeconds: 0.4 },
      });

      if (chance(0.84)) {
        t += rand(0.2, 0.6);
        events.push({
          t,
          type: "panel_opened",
          surface: "gui",
          componentId: component.componentId,
          productId: component.productId,
          meta: { openMethod: "prompt" },
        });

        const openSeconds = clamp(lognormalish(6 + appeal * 9, 0.6), 1.5, 90);
        const activeSeconds = clamp(openSeconds * rand(0.35, 0.95), 0.5, openSeconds);

        // Clothing panels list the whole range, so a player standing at one
        // mannequin can browse to another. Whatever they end up wanting is
        // attention this display earned for a product it is not showing.
        let shown = component;
        const engagements = Math.floor(rand(0, 1.2 + appeal * 5));
        for (let e = 0; e < engagements; e++) {
          t += rand(0.6, 2.4);
          const canTab = component.kind === "Mannequin";
          const action = canTab
            ? ["variant_select", "image_next", "scroll", "tab"][Math.floor(Math.random() * 4)]
            : ["variant_select", "image_next", "scroll"][Math.floor(Math.random() * 3)];

          const meta: Record<string, unknown> = { action };
          if (action === "tab") {
            const others = registry.components.filter(
              (c) => c.kind === "Mannequin" && c.componentId !== shown.componentId,
            );
            if (others.length > 0) {
              const target = others[Math.floor(Math.random() * others.length)];
              meta.toComponentId = target.componentId;
              meta.fromComponentId = component.componentId;
              shown = target;
            }
          }

          events.push({
            t,
            type: "panel_engaged",
            surface: "gui",
            componentId: shown.componentId,
            productId: shown.productId,
            meta,
          });
        }

        // Expensive things lose people at the decision, not at the display.
        const shownAppeal = APPEAL[shown.componentId] ?? DEFAULT_APPEAL;
        const priceResistance = clamp(shown.price / 260, 0, 0.34);
        const pCta = clamp(0.12 + 0.72 * shownAppeal - priceResistance, 0.02, 0.82);
        const clicked = activeSeconds > 2 && chance(pCta);

        if (clicked) {
          t += rand(0.5, 2);
          events.push({
            t,
            type: "panel_cta_clicked",
            surface: "gui",
            componentId: shown.componentId,
            productId: shown.productId,
          });
          t += rand(0.3, 1.2);
          events.push({
            t,
            type: "shopify_link_shown",
            surface: "gui",
            componentId: shown.componentId,
            productId: shown.productId,
            meta: { claimCode: `SIM-${Math.floor(Math.random() * 1e6)}` },
          });
        }

        t += rand(0.5, 2);
        events.push({
          t,
          type: "panel_closed",
          surface: "gui",
          componentId: shown.componentId,
          productId: shown.productId,
          meta: {
            openSeconds: Number(openSeconds.toFixed(2)),
            activeSeconds: Number(activeSeconds.toFixed(2)),
            closeReason: clicked ? "manual" : chance(0.6) ? "manual" : "walked_away",
          },
        });
      }
    }

    t += rand(0.5, 2);
    events.push({
      t,
      type: "display_dwell",
      surface: "physical",
      componentId: component.componentId,
      productId: component.productId,
      pos: [...pos],
      meta: {
        dwellSeconds: Number(dwell.toFixed(2)),
        minDistance,
        minSpeed: Number(minSpeed.toFixed(1)),
        hadLineOfSight: sawIt,
      },
    });

    // Back out to the aisle before carrying on.
    walkTo([AISLE_X + rand(-6, 6), 5, component.pos[2] + rand(2, 8)]);
  }

  t += rand(2, 8);
  events.push({
    t,
    type: "session_ended",
    pos: [...pos],
    meta: { durationSeconds: Number((t - t0).toFixed(1)) },
  });

  return events;
}

main().catch((error) => {
  console.error("[sim] failed:", error);
  process.exit(1);
});
