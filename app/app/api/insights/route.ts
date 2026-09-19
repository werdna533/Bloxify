import { db } from "@/lib/db";
import { componentMetrics } from "@/lib/metrics";
import { readRegistry } from "@/app/api/registry/route";
import { proposePlan } from "@/lib/ai";
import { validatePlan } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    experimentId?: string | null;
    source?: "sim" | "live" | "all";
  };

  const registry = readRegistry();
  if (!registry) {
    return Response.json(
      { error: "no registry — run `npx tsx bridge/pull-registry.ts` first" },
      { status: 400 },
    );
  }

  const source = body.source ?? "all";
  const metrics = componentMetrics(body.experimentId ?? null, source);
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
    previousExperiments: previousExperiments(),
    dataProvenance: source,
  };

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

function previousExperiments() {
  const rows = db()
    .prepare(
      `SELECT id, hypothesis, plan_json, result_json, status
       FROM experiments WHERE status IN ('applied', 'done') ORDER BY created_at DESC LIMIT 5`,
    )
    .all() as {
    id: string;
    hypothesis: string | null;
    plan_json: string | null;
    status: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    hypothesis: r.hypothesis,
    changes: r.plan_json ? (JSON.parse(r.plan_json).ops ?? []) : [],
    status: r.status,
  }));
}
