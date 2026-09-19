import { requireAuth, type Env } from "./env";
import { ExperimentRun } from "./experiment-run";
import { proposePlan, validatePlan, type Plan } from "./plan";
import { ingestEvents } from "./ingest";
import { getRegistry, postRegistry, getGeometry, postGeometry } from "./kv";
import { analytics, heatmap, compare } from "./reads";

export { ExperimentRun };

type QueuedRow = {
  id: string;
  plan_json: string | null;
  snapshot_before_json: string | null;
  status: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The Bridge's own code is shared between backends — it calls
    // /api/bridge/next the way the Next.js App Router expects, and that does
    // not change just because the target moved. Accept the path either way.
    const rawPath = new URL(request.url).pathname;
    const pathname = rawPath.startsWith("/api/") ? rawPath.slice(4) : rawPath;

    if (pathname === "/health") return health(env);

    const unauthorized = requireAuth(request, env);
    if (unauthorized) return unauthorized;

    if (pathname === "/bridge/next" && request.method === "GET") return bridgeNext(env);
    if (pathname === "/bridge/result" && request.method === "POST") return bridgeResult(request, env);

    if (pathname === "/plan" && request.method === "POST") return plan(request, env);
    if (pathname === "/events" && request.method === "POST") return ingestEvents(request, env);
    if (pathname === "/registry" && request.method === "GET") return getRegistry(request, env);
    if (pathname === "/registry" && request.method === "POST") return postRegistry(request, env);
    if (pathname === "/geometry" && request.method === "GET") return getGeometry(request, env);
    if (pathname === "/geometry" && request.method === "POST") return postGeometry(request, env);
    if (pathname === "/analytics" && request.method === "GET") return analytics(request, env);
    if (pathname === "/heatmap" && request.method === "GET") return heatmap(request, env);
    if (pathname === "/compare" && request.method === "GET") return compare(request, env);
    if (pathname === "/experiments" && request.method === "GET") return listExperiments(env);
    if (pathname === "/experiments" && request.method === "POST") return createExperiment(request, env);

    const queued = pathname.match(/^\/experiments\/([^/]+)\/(apply|rollback)$/);
    if (queued && request.method === "POST") return queueExperiment(env, queued[1], queued[2]);

    const shot = pathname.match(/^\/shots\/(.+)$/);
    if (shot && request.method === "GET") return readShot(env, shot[1]);

    return Response.json({ error: "not found" }, { status: 404 });
  },
};

// Unauthenticated on purpose: it reports reachability and binding wiring, no data.
async function health(env: Env): Promise<Response> {
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     AND name NOT LIKE '_cf_%' ORDER BY name`,
  ).all<{ name: string }>();

  return Response.json({
    ok: true,
    tables: tables.results.map((r) => r.name),
    authConfigured: Boolean(env.BACKEND_AUTH_TOKEN),
  });
}

// The Bridge polls this. Response shape matches the Next.js route exactly so the
// Bridge switches over with only BRIDGE_TARGET changed.
async function bridgeNext(env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, plan_json, snapshot_before_json, status FROM experiments
     WHERE status IN ('queued', 'rollback_queued') ORDER BY created_at ASC LIMIT 1`,
  ).first<QueuedRow>();

  if (!row) return Response.json({ pending: false });

  const isRestore = row.status === "rollback_queued";
  const run = runFor(env, row.id);

  await run.fetch(
    new Request("https://do/start", {
      method: "POST",
      body: JSON.stringify({
        experimentId: row.id,
        action: isRestore ? "restore" : "apply",
        plan: row.plan_json ? JSON.parse(row.plan_json) : null,
        snapshot: row.snapshot_before_json ?? undefined,
      }),
    }),
  );

  const claimed = await run.fetch(new Request("https://do/claim", { method: "POST" }));
  const job = await claimed.json<{ pending: boolean }>();
  if (!job.pending) return Response.json({ pending: false });

  await env.DB.prepare(`UPDATE experiments SET status = ? WHERE id = ?`)
    .bind(isRestore ? "rolling_back" : "applying", row.id)
    .run();

  return Response.json(job);
}

/**
 * The Bridge posts progress here in several calls per run — a snapshot before
 * the risky part, then applied/captured or rolled_back, or failed at any
 * point. This mirrors app/api/bridge/result/route.ts exactly, field for
 * field, because the Bridge's own code does not change between backends;
 * only BRIDGE_TARGET does.
 */
async function bridgeResult(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    experimentId?: string;
    stage?: "failed" | "applied" | "captured" | "rolled_back";
    snapshot?: string;
    result?: unknown;
    imageAfter?: string;
    error?: string;
  }>();

  if (!body.experimentId) {
    return Response.json({ error: "experimentId required" }, { status: 400 });
  }

  if (body.snapshot) {
    await env.DB.prepare(`UPDATE experiments SET snapshot_before_json = ? WHERE id = ?`)
      .bind(body.snapshot, body.experimentId)
      .run();
  }

  if (body.imageAfter) {
    // The image itself goes to R2, not a D1 row; only the key is stored.
    const key = `${body.experimentId}/after-${Date.now()}.png`;
    const base64 = body.imageAfter.split(",")[1] ?? body.imageAfter;
    await env.SHOTS.put(key, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), {
      httpMetadata: { contentType: "image/png" },
    });
    await env.DB.prepare(`UPDATE experiments SET image_after_key = ? WHERE id = ?`)
      .bind(key, body.experimentId)
      .run();
  }

  if (body.result) {
    await env.DB.prepare(`UPDATE experiments SET result_json = ? WHERE id = ?`)
      .bind(JSON.stringify({ applyResult: body.result }), body.experimentId)
      .run();
  }

  if (body.stage) {
    const status =
      body.stage === "failed" ? "failed" : body.stage === "captured" ? "done" : body.stage;
    await env.DB.prepare(`UPDATE experiments SET status = ?, error = ? WHERE id = ?`)
      .bind(status, body.error ?? null, body.experimentId)
      .run();

    // Only a terminal stage clears the claim timeout alarm — an intermediate
    // "snapshot stored" is not proof the Bridge is still alive and working.
    if (body.stage === "failed" || body.stage === "captured" || body.stage === "rolled_back") {
      const run = runFor(env, body.experimentId);
      await run.fetch(
        new Request("https://do/report", {
          method: "POST",
          body: JSON.stringify({ ok: body.stage !== "failed", error: body.error }),
        }),
      );
    }
  }

  return Response.json({ ok: true });
}

function runFor(env: Env, experimentId: string): DurableObjectStub {
  return env.EXPERIMENT_RUN.get(env.EXPERIMENT_RUN.idFromName(experimentId));
}

// ------------------------------------------------------------------ planning

/**
 * The agent's brain. The dashboard posts the context it already has rather
 * than the Worker reaching back through the tunnel for metrics, so this path
 * does not depend on the local backend being publicly reachable.
 */
async function plan(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ context?: unknown; registry?: RegistryShape }>();
  if (!body.context || !body.registry) {
    return Response.json({ error: "context and registry are required" }, { status: 400 });
  }

  const result = await proposePlan(env, body.context);
  if (!result.ok) {
    return Response.json({ error: result.error, raw: result.raw }, { status: 502 });
  }

  const validation = validatePlan(result.plan, body.registry);
  return Response.json({ plan: result.plan, validation, model: result.model });
}

type RegistryShape = {
  components: { componentId: string }[];
  slots: { slotId: string }[];
  kinds: string[];
};

// --------------------------------------------------------------- experiments

async function listExperiments(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, name, hypothesis, status, created_at, plan_json, error,
            snapshot_before_json IS NOT NULL AS snapshot_before_json,
            image_after_key IS NOT NULL AS has_image_after
     FROM experiments ORDER BY created_at DESC LIMIT 25`,
  ).all();
  return Response.json({ experiments: rows.results });
}

async function createExperiment(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    hypothesis?: string;
    name?: string;
    plan?: Plan;
    validation?: { accepted?: unknown[] };
  }>();
  if (!body.plan) return Response.json({ error: "plan is required" }, { status: 400 });

  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM experiments`).first<{ n: number }>();
  const id = `exp_${String((count?.n ?? 0) + 1).padStart(2, "0")}`;

  // Only the operations the validator accepted are ever stored for execution.
  const accepted = body.validation?.accepted ?? [];
  await env.DB.prepare(
    `INSERT INTO experiments (id, name, hypothesis, status, created_at, plan_json, result_json)
     VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
  )
    .bind(
      id,
      body.name ?? id,
      body.hypothesis ?? null,
      Date.now() / 1000,
      JSON.stringify({ experimentId: id, ops: accepted }),
      JSON.stringify({ proposed: body.plan, validation: body.validation ?? null }),
    )
    .run();

  return Response.json({ id, status: "draft", ops: accepted.length });
}

async function queueExperiment(env: Env, id: string, verb: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, status, plan_json, snapshot_before_json FROM experiments WHERE id = ?`,
  ).bind(id).first<QueuedRow>();

  if (!row) return Response.json({ error: `unknown experiment ${id}` }, { status: 404 });

  if (verb === "rollback" && !row.snapshot_before_json) {
    return Response.json(
      { error: "no snapshot stored for this experiment — nothing to roll back to" },
      { status: 400 },
    );
  }
  if (verb === "apply" && !row.plan_json) {
    return Response.json({ error: "experiment has no plan" }, { status: 400 });
  }

  const status = verb === "rollback" ? "rollback_queued" : "queued";
  await env.DB.prepare(`UPDATE experiments SET status = ?, error = NULL WHERE id = ?`)
    .bind(status, id)
    .run();

  return Response.json({ id, status });
}

// Before/after captures live in R2, not as base64 blobs in a database row.
async function readShot(env: Env, key: string): Promise<Response> {
  const object = await env.SHOTS.get(key);
  if (!object) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(object.body, {
    headers: { "Content-Type": object.httpMetadata?.contentType ?? "image/png" },
  });
}
