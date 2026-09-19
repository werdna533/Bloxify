import { db } from "@/lib/db";
import { componentMetrics } from "@/lib/metrics";
import { readRegistry } from "@/app/api/registry/route";
import { proposePlan } from "@/lib/ai";
import { validatePlan } from "@/lib/validate";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    experimentId?: string | null;
    source?: "sim" | "live" | "all";
  };

  const registry = await readRegistry();
  if (!registry) {
    return Response.json(
      { error: "no registry — run `npx tsx bridge/pull-registry.ts` first" },
      { status: 400 },
    );
  }

  const source = body.source ?? "all";
  const metrics = await getComponentMetrics(body.experimentId ?? null, source);
  if (metrics.length === 0) {
    return Response.json({ error: "no metrics yet — seed or collect some sessions" }, { status: 400 });
  }

  const rankBySlot = new Map(registry.slots.map((s) => [s.slotId, s.trafficRank]));
  const metricsById = new Map(metrics.map((m) => [m.componentId, m]));

  // Small and structured. The model never sees raw event rows.
  const context = {
    store: {
      slots: registry.slots.map((s) => ({
        slotId: s.slotId,
        trafficRank: s.trafficRank,
        visibilityScore: s.visibilityScore ?? null,
      })),
      kinds: registry.kinds,
      note:
        "trafficRank 1 is the busiest corridor, 8 is a dead corner. visibilityScore is separate: " +
        "thing again: the share of nearby standing positions from which the slot can physically be " +
        "seen, measured by raycast against the room geometry. Do not confuse it with sightlineRate " +
        "in the metrics, which is a behavioural ratio. A slot can be close to the spawn and still be " +
        "hidden behind scenery, and moving a product into a low visibilityScore slot will starve it.",
    },
    components: registry.components.map((c) => ({
      componentId: c.componentId,
      title: c.title,
      price: c.price,
      slotId: c.slotId,
      trafficRank: rankBySlot.get(c.slotId) ?? null,
      kind: c.kind,
      prominence: c.prominence,
      interactionEnabled: c.interactionEnabled,
      ctaText: c.ctaText,
    })),
    metrics: registry.components.map((c) => {
      const m = metricsById.get(c.componentId);
      return {
        componentId: c.componentId,
        impressions: m?.impressions ?? 0,
        approaches: m?.approaches ?? 0,
        dwellSeconds: m?.dwellSeconds ?? 0,
        gazeSeconds: m?.gazeSeconds ?? 0,
        interactions: m?.interactions ?? 0,
        hesitations: m?.hesitations ?? 0,
        panelOpens: m?.panelOpens ?? 0,
        panelActiveSeconds: m?.panelActiveSeconds ?? 0,
        ctaClicks: m?.ctaClicks ?? 0,
        purchases: m?.purchases ?? 0,
        sightlineRate: m?.sightlineRate ?? null,
        engagementRate: m?.engagementRate ?? null,
        depthRate: m?.depthRate ?? null,
        intentRate: m?.intentRate ?? null,
        approachConcordance: m?.approachConcordance ?? null,
      };
    }),
    previousExperiments: await getPreviousExperiments(),
    dataProvenance: source,
  };

  if (env.workerUrl) {
    const response = await fetch(`${env.workerUrl}/plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.backendAuthToken}`,
      },
      body: JSON.stringify({ context, registry }),
      cache: "no-store",
    });
    const workerBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(workerBody, { status: response.status });
    }
    return Response.json({
      ...workerBody,
      context: { components: context.components.length, metrics: context.metrics.length },
    });
  }

  const result = await proposePlan(context);
  if (!result.ok) {
    return Response.json({ error: result.error, raw: result.raw }, { status: 502 });
  }

  const validation = validatePlan(result.plan, registry);

  return Response.json({
    plan: result.plan,
    validation,
    model: result.model,
    context: { components: context.components.length, metrics: context.metrics.length },
  });
}

/**
 * Metrics behind the Worker when configured, so this reasons about the same
 * experiments table the dashboard's compare view reads — not a local copy
 * that writes stopped landing in once /api/experiments moved to D1.
 */
async function getComponentMetrics(experimentId: string | null, source: "sim" | "live" | "all") {
  if (env.workerUrl) {
    const query = new URLSearchParams({ source });
    if (experimentId) query.set("experimentId", experimentId);
    const res = await fetch(`${env.workerUrl}/analytics?${query}`, {
      headers: { Authorization: `Bearer ${env.backendAuthToken}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { components: ReturnType<typeof componentMetrics> };
    return data.components;
  }
  return componentMetrics(experimentId, source);
}

async function getPreviousExperiments() {
  type Row = { id: string; hypothesis: string | null; plan_json: string | null; status: string };

  let rows: Row[];
  if (env.workerUrl) {
    const res = await fetch(`${env.workerUrl}/experiments`, {
      headers: { Authorization: `Bearer ${env.backendAuthToken}` },
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({ experiments: [] }))) as { experiments: Row[] };
    rows = (data.experiments ?? [])
      .filter((r) => r.status === "applied" || r.status === "done")
      .slice(0, 5);
  } else {
    rows = db()
      .prepare(
        `SELECT id, hypothesis, plan_json, result_json, status
         FROM experiments WHERE status IN ('applied', 'done') ORDER BY created_at DESC LIMIT 5`,
      )
      .all() as Row[];
  }

  return rows.map((r) => ({
    id: r.id,
    hypothesis: r.hypothesis,
    changes: r.plan_json ? (JSON.parse(r.plan_json).ops ?? []) : [],
    status: r.status,
  }));
}
