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
  const sessionCount = Number(
    process.argv[process.argv.indexOf("--sessions") + 1] || 400,
  );

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

function buildSession(
  registry: Registry,
  rankBySlot: Map<string, number>,
  t0: number,
): SimEvent[] {
  const events: SimEvent[] = [];
  let t = t0;

  events.push({ t, type: "session_started", pos: SPAWN });

  // Walk up the aisle. Players who lose interest turn back early, which is
  // what makes far slots genuinely worse rather than uniformly worse.
  const patience = rand(0.35, 1.0);
  const walkDepth = 30 + patience * 90;
  let z = 0;
  let lastPathZ = -99;
  const walkSpeed = rand(11, 17);

  const encounters: { componentId: string; z: number }[] = [];
  for (const c of registry.components) {
    if (c.pos[2] <= walkDepth) encounters.push({ componentId: c.componentId, z: c.pos[2] });
  }
  encounters.sort((a, b) => a.z - b.z);

  while (z < walkDepth) {
    z += rand(2.5, 6);
    t += rand(2.5, 6) / walkSpeed;
    if (z - lastPathZ > 2) {
      events.push({
        t,
        type: "path_point",
        pos: [AISLE_X + rand(-9, 9), 5, z],
        look: [rand(-0.3, 0.3), 0, 1],
      });
      lastPathZ = z;
    }
  }

  for (const enc of encounters) {
    const component = registry.components.find((c) => c.componentId === enc.componentId)!;
    const rank = rankBySlot.get(component.slotId) ?? 8;
    const appeal = APPEAL[component.componentId] ?? DEFAULT_APPEAL;
    const prominenceBonus = (component.prominence - 1) * 0.08;
    t += rand(1.5, 4);

    // Did they ever see it? This is the distinction a web pixel cannot make.
    const pImpression = clamp(1.02 - 0.085 * rank, 0.25, 0.97);
    if (!chance(pImpression)) continue;

    const distance = rand(22, 38);
    events.push({
      t,
      type: "display_impression",
      surface: "physical",
      componentId: component.componentId,
      productId: component.productId,
      pos: [AISLE_X + rand(-6, 6), 5, enc.z - rand(14, 24)],
      meta: { distance: Number(distance.toFixed(1)) },
    });

    const pApproach = clamp(
      0.24 + 0.46 * appeal + 0.22 * (1 - rank / 8) + prominenceBonus,
      0.04,
      0.92,
    );
    if (!chance(pApproach)) continue;

    t += rand(1, 3);
    // Everything faces the aisle, so most approaches are head-on; the tail is
    // people cutting across from behind.
    const bearing = chance(0.82) ? rand(0, 55) : rand(95, 175);
    events.push({
      t,
      type: "display_approach",
      surface: "physical",
      componentId: component.componentId,
      productId: component.productId,
      pos: [component.pos[0] + rand(-4, 4), 5, component.pos[2] + rand(-4, 4)],
      meta: {
        fromSlot: "aisle",
        approachBearing: Number(bearing.toFixed(1)),
        entrySpeed: Number(rand(8, 17).toFixed(1)),
      },
    });

    const dwell = clamp(lognormalish(4.5 + appeal * 7, 0.55), 1.2, 60);
    const minDistance = rand(2.4, 7.5);
    const minSpeed = rand(0, 9);

    const sawIt = bearing < 90;
    const pGaze = sawIt ? 0.82 : 0.22;
    let gazeSeconds = 0;
    if (chance(pGaze)) {
      gazeSeconds = clamp(lognormalish(1.8 + appeal * 4.5, 0.6), 0.75, 40);
      t += gazeSeconds;
      events.push({
        t,
        type: "display_gaze",
        surface: "physical",
        componentId: component.componentId,
        productId: component.productId,
        meta: {
          gazeSeconds: Number(gazeSeconds.toFixed(2)),
          distance: Number(minDistance.toFixed(1)),
        },
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

        const engagements = Math.floor(rand(0, 1.2 + appeal * 5));
        for (let e = 0; e < engagements; e++) {
          t += rand(0.6, 2.4);
          const action = ["variant_select", "image_next", "scroll", "tab"][
            Math.floor(Math.random() * 4)
          ];
          events.push({
            t,
            type: "panel_engaged",
            surface: "gui",
            componentId: component.componentId,
            productId: component.productId,
            meta: { action },
          });
        }

        // Expensive things lose people at the decision, not at the display.
        const priceResistance = clamp(component.price / 260, 0, 0.34);
        const pCta = clamp(0.12 + 0.72 * appeal - priceResistance, 0.02, 0.82);
        const clicked = activeSeconds > 2 && chance(pCta);

        if (clicked) {
          t += rand(0.5, 2);
          events.push({
            t,
            type: "panel_cta_clicked",
            surface: "gui",
            componentId: component.componentId,
            productId: component.productId,
          });
          t += rand(0.3, 1.2);
          events.push({
            t,
            type: "shopify_link_shown",
            surface: "gui",
            componentId: component.componentId,
            productId: component.productId,
            meta: { claimCode: `SIM-${Math.floor(Math.random() * 1e6)}` },
          });
        }

        t += rand(0.5, 2);
        events.push({
          t,
          type: "panel_closed",
          surface: "gui",
          componentId: component.componentId,
          productId: component.productId,
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
      meta: {
        dwellSeconds: Number(dwell.toFixed(2)),
        minDistance: Number(minDistance.toFixed(1)),
        minSpeed: Number(minSpeed.toFixed(1)),
        hadLineOfSight: sawIt,
      },
    });
  }

  t += rand(2, 8);
  events.push({
    t,
    type: "session_ended",
    pos: [AISLE_X + rand(-8, 8), 5, z],
    meta: { durationSeconds: Number((t - t0).toFixed(1)) },
  });

  return events;
}

main().catch((error) => {
  console.error("[sim] failed:", error);
  process.exit(1);
});
