/**
 * The Bridge: polls the backend for approved change plans and applies them to
 * the open Roblox Studio place over MCP.
 *
 * Runs on the same machine as Studio because Studio MCP speaks stdio, so the
 * web backend cannot reach it directly.
 *
 *   npx tsx index.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { StudioBridge } from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "..", ".env.local"), quiet: true });

const BASE_URL = process.env.BRIDGE_TARGET ?? "http://localhost:3000";
const AUTH_TOKEN = process.env.BACKEND_AUTH_TOKEN ?? "";
const POLL_MS = 2000;

// A fixed vantage point so before and after are the same shot.
const DEMO_CAMERA = { pos: [-78, 12, 2], lookAt: [-80, 7, 70] };

if (!AUTH_TOKEN) {
  console.error("[bridge] BACKEND_AUTH_TOKEN missing from .env.local");
  process.exit(1);
}

type Pending = {
  pending: boolean;
  action?: "apply" | "restore";
  experimentId?: string;
  plan?: { experimentId: string; ops: Record<string, unknown>[] };
  snapshot?: string;
};

function authHeaders() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_TOKEN}` };
}

async function report(body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/api/bridge/result`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`[bridge] result POST failed: HTTP ${res.status} ${await res.text()}`);
  } catch (error) {
    console.error("[bridge] could not report result:", error);
  }
}

/**
 * Pulls the registry back out of Studio and stores it.
 *
 * Without this the backend keeps describing the layout from before the apply,
 * so the dashboard draws displays in the wrong slots and the model reasons
 * about a store that no longer exists — and nothing looks broken while it does.
 */
async function refreshRegistry(bridge: StudioBridge): Promise<void> {
  const result = await bridge.executeLuau(
    `return require(game.ServerScriptService.Storefront.StorefrontAPI).registry()`,
    "Edit",
  );
  if (result.isError) {
    console.error(`[bridge] registry refresh failed: ${result.text}`);
    return;
  }
  try {
    const res = await fetch(`${BASE_URL}/api/registry`, {
      method: "POST",
      headers: authHeaders(),
      body: result.text,
    });
    console.log(`[bridge] registry refreshed (${res.status})`);
  } catch (error) {
    console.error("[bridge] could not post refreshed registry:", error);
  }
}

/** Long-bracket level that cannot collide with the JSON payload. */
function luauLongString(payload: string): string {
  let eq = "==";
  while (payload.includes(`]${eq}]`)) eq += "=";
  return `[${eq}[${payload}]${eq}]`;
}

async function applyExperiment(bridge: StudioBridge, pending: Pending): Promise<void> {
  const experimentId = pending.experimentId!;
  const plan = pending.plan!;
  console.log(`[bridge] ${experimentId}: ${plan.ops.length} op(s) to apply`);

  // Edits made while playing are thrown away when play stops.
  const state = await bridge.call("get_studio_state", { studio_id: await bridge.getStudioId() });
  if (!/Current Studio Mode:\s*Edit/i.test(state.text)) {
    const message = `Studio is not in Edit mode (${state.text.replace(/\s+/g, " ").trim()}). Changes made in play mode are discarded, so nothing was applied.`;
    console.error(`[bridge] ${message}`);
    await report({ experimentId, stage: "failed", error: message });
    return;
  }

  // 1. Snapshot first, so rollback exists even if the apply half-fails.
  const snapshot = await bridge.executeLuau(
    `return require(game.ServerScriptService.Storefront.StorefrontAPI).snapshot()`,
    "Edit",
  );
  if (snapshot.isError) {
    await report({ experimentId, stage: "failed", error: `snapshot failed: ${snapshot.text}` });
    return;
  }
  await report({ experimentId, snapshot: snapshot.text });
  console.log(`[bridge] ${experimentId}: snapshot stored (${snapshot.text.length} bytes)`);

  // 2. Apply.
  const planJson = JSON.stringify(plan);
  const applyResult = await bridge.executeLuau(
    `local plan = ${luauLongString(planJson)}\n` +
      `return require(game.ServerScriptService.Storefront.StorefrontAPI).apply(plan)`,
    "Edit",
  );
  if (applyResult.isError) {
    await report({ experimentId, stage: "failed", error: `apply failed: ${applyResult.text}` });
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(applyResult.text) as Record<string, unknown>;
  } catch {
    await report({
      experimentId,
      stage: "failed",
      error: `apply returned unparseable result: ${applyResult.text.slice(0, 300)}`,
    });
    return;
  }
  console.log(
    `[bridge] ${experimentId}: applied ${JSON.stringify((parsed.applied as unknown[]) ?? [])}, rejected ${
      JSON.stringify((parsed.rejected as unknown[]) ?? [])
    }`,
  );
  await report({ experimentId, stage: "applied", result: parsed });

  // 3. Capture the after shot. Non-fatal: a blank viewport must not fail an
  //    apply that already succeeded.
  try {
    const shot = await bridge.call("screen_capture", {
      studio_id: await bridge.getStudioId(),
      capture_id: `after_${experimentId}`,
      camera_position: DEMO_CAMERA.pos,
      look_at_position: DEMO_CAMERA.lookAt,
    });
    if (shot.images.length > 0) {
      await report({ experimentId, imageAfter: `data:image/png;base64,${shot.images[0]}` });
      console.log(`[bridge] ${experimentId}: after image captured`);
    } else {
      console.warn(`[bridge] ${experimentId}: screen_capture returned no image, skipping`);
    }
  } catch (error) {
    console.warn(`[bridge] ${experimentId}: screen_capture failed, skipping:`, error);
  }

  await refreshRegistry(bridge);
  await report({ experimentId, stage: "captured" });
  console.log(`[bridge] ${experimentId}: done`);
}

async function restoreExperiment(bridge: StudioBridge, pending: Pending): Promise<void> {
  const experimentId = pending.experimentId!;
  console.log(`[bridge] ${experimentId}: restoring pre-apply snapshot`);

  const result = await bridge.executeLuau(
    `local snap = ${luauLongString(pending.snapshot!)}\n` +
      `return require(game.ServerScriptService.Storefront.StorefrontAPI).restore(snap)`,
    "Edit",
  );
  if (result.isError) {
    await report({ experimentId, stage: "failed", error: `restore failed: ${result.text}` });
    return;
  }
  console.log(`[bridge] ${experimentId}: restored — ${result.text}`);
  await refreshRegistry(bridge);
  await report({ experimentId, stage: "rolled_back" });
}

async function main() {
  const bridge = new StudioBridge();
  await bridge.connect();
  await bridge.getStudioId();
  console.log(`[bridge] polling ${BASE_URL}/api/bridge/next every ${POLL_MS}ms`);

  let idleLogged = false;
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/api/bridge/next`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const pending = (await res.json()) as Pending;

      if (pending.pending && pending.experimentId) {
        idleLogged = false;
        if (pending.action === "restore" && pending.snapshot) {
          await restoreExperiment(bridge, pending);
        } else if (pending.plan) {
          await applyExperiment(bridge, pending);
        }
      } else if (!idleLogged) {
        console.log("[bridge] connected, waiting for a plan");
        idleLogged = true;
      }
    } catch (error) {
      // Studio MCP dies when Studio closes or the place changes; re-handshake
      // rather than exiting, so the demo survives it.
      console.error("[bridge] poll error:", error instanceof Error ? error.message : error);
      try {
        await bridge.reconnect();
        await bridge.getStudioId();
        console.log("[bridge] reconnected to Studio");
      } catch (reconnectError) {
        console.error("[bridge] reconnect failed, retrying next tick:", reconnectError);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main().catch((error) => {
  console.error("[bridge] fatal:", error);
  process.exit(1);
});
