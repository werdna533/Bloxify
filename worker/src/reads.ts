import type { Env } from "./env";
import { readKv } from "./kv";
import {
  componentMetrics,
  sourceBreakdown,
  experimentIds,
  bucketedLayer,
  sessionCount,
  type SourceFilter,
  type ComponentMetrics,
} from "./metrics";

type RegistryRegion = { center: number[]; size: number[]; rotationY: number; floorY: number };
type RegistryComponent = {
  componentId: string;
  productId: string;
  title: string;
  price: number;
  kind: string;
  prominence: number;
  interactionEnabled: boolean;
  ctaText?: string;
  signageText?: string;
  visibilityScore?: number | null;
  pos: number[];
  facing: number[];
};
type Registry = {
  region: RegistryRegion | null;
  components: RegistryComponent[];
  kinds: string[];
  hasStorefront: boolean;
  experimentId: string;
  place?: { name: string; placeId: number; gameId: number };
};

async function getRegistryData(env: Env): Promise<Registry | null> {
  return (await readKv(env, "registry")) as Registry | null;
}

export async function analytics(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const experimentId = url.searchParams.get("experimentId");
  const source = (url.searchParams.get("source") ?? "all") as SourceFilter;
  const wantHeatmap = url.searchParams.get("heatmap") === "1";

  const registry = await getRegistryData(env);
  const metrics = await componentMetrics(env, experimentId, source);
  const byComponent = new Map(registry?.components.map((c) => [c.componentId, c]) ?? []);

  const rows = metrics.map((m) => {
    const component = byComponent.get(m.componentId);
    return {
      ...m,
      title: component?.title ?? m.componentId,
      price: component?.price ?? null,
      pos: component?.pos ?? null,
      facing: component?.facing ?? null,
      visibilityScore: component?.visibilityScore ?? null,
      kind: component?.kind ?? null,
      prominence: component?.prominence ?? null,
    };
  });

  return Response.json({
    experimentId,
    source,
    experiments: await experimentIds(env),
    sourceBreakdown: await sourceBreakdown(env, experimentId),
    region: registry?.region ?? null,
    hasStorefront: registry?.hasStorefront ?? false,
    place: registry?.place ?? null,
    components: rows,
    heatmap: wantHeatmap ? await bucketedLayer(env, ["path_point"], experimentId, source, 2) : undefined,
  });
}

const BUCKET = 3;

export async function heatmap(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const experimentId = url.searchParams.get("experimentId");
  const source = (url.searchParams.get("source") ?? "all") as SourceFilter;
  const expClause = experimentId ? `AND experiment_id = ?` : "";
  const binds = experimentId ? [experimentId] : [];
  const src = source === "all" ? "" : `AND source = '${source}'`;

  const layers = {
    traffic: await bucketedLayer(env, ["path_point"], experimentId, source, BUCKET),
    attention: await bucketedLayer(env, ["display_gaze"], experimentId, source, BUCKET, "gazeSeconds"),
    approach: await bucketedLayer(env, ["display_approach", "display_revisit"], experimentId, source, BUCKET),
    interaction: await bucketedLayer(env, ["display_interacted"], experimentId, source, BUCKET),
    hesitation: await bucketedLayer(env, ["display_hesitation"], experimentId, source, BUCKET),
  };

  const gazeRays = (
    await env.DB.prepare(
      `SELECT x, y, z, component_id AS componentId, json_extract(meta_json, '$.gazeSeconds') AS seconds
       FROM events WHERE type = 'display_gaze' AND x IS NOT NULL AND component_id IS NOT NULL
       ${expClause} ${src} ORDER BY seconds DESC LIMIT 500`,
    )
      .bind(...binds)
      .all()
  ).results as { x: number; y: number; z: number; componentId: string; seconds: number }[];

  const impressionRays = (
    await env.DB.prepare(
      `SELECT x, y, z, component_id AS componentId, json_extract(meta_json, '$.distance') AS distance
       FROM events WHERE type = 'display_impression' AND x IS NOT NULL AND component_id IS NOT NULL
       ${expClause} ${src} ORDER BY distance DESC LIMIT 400`,
    )
      .bind(...binds)
      .all()
  ).results as { x: number; y: number; z: number; componentId: string; distance: number }[];

  const tabFlows = (
    await env.DB.prepare(
      `SELECT json_extract(meta_json, '$.fromComponentId') AS source,
              json_extract(meta_json, '$.toComponentId')   AS target, COUNT(*) AS n
       FROM events WHERE type = 'panel_engaged' AND json_extract(meta_json, '$.toComponentId') IS NOT NULL
       ${expClause} ${src} GROUP BY 1, 2`,
    )
      .bind(...binds)
      .all()
  ).results as { source: string | null; target: string; n: number }[];

  const registry = await getRegistryData(env);
  const metrics = await componentMetrics(env, experimentId, source);
  const metricById = new Map(metrics.map((m) => [m.componentId, m]));

  const tabbedTo = new Map<string, number>();
  const tabbedAway = new Map<string, number>();
  for (const flow of tabFlows) {
    tabbedTo.set(flow.target, (tabbedTo.get(flow.target) ?? 0) + flow.n);
    if (flow.source) tabbedAway.set(flow.source, (tabbedAway.get(flow.source) ?? 0) + flow.n);
  }

  const items = (registry?.components ?? []).map((c) => {
    const m = metricById.get(c.componentId);
    const impressions = m?.impressions ?? 0;
    const approaches = m?.approaches ?? 0;
    const panelOpens = m?.panelOpens ?? 0;
    const arrived = tabbedTo.get(c.componentId) ?? 0;
    const pullRate = impressions > 0 ? approaches / impressions : null;
    const holdSeconds = approaches > 0 ? (m?.gazeSeconds ?? 0) / approaches : null;
    const intentRate = panelOpens > 0 ? (m?.ctaClicks ?? 0) / panelOpens : null;
    return {
      componentId: c.componentId,
      title: c.title,
      price: c.price,
      pos: c.pos,
      impressions,
      approaches,
      gazeSeconds: m?.gazeSeconds ?? 0,
      interactions: m?.interactions ?? 0,
      hesitations: m?.hesitations ?? 0,
      panelOpens,
      panelActiveSeconds: m?.panelActiveSeconds ?? 0,
      ctaClicks: m?.ctaClicks ?? 0,
      pullRate: pullRate === null ? null : Number(pullRate.toFixed(4)),
      holdSeconds: holdSeconds === null ? null : Number(holdSeconds.toFixed(2)),
      intentRate: intentRate === null ? null : Number(intentRate.toFixed(4)),
      borrowedIn: arrived,
      lentOut: tabbedAway.get(c.componentId) ?? 0,
      borrowedShare: panelOpens + arrived > 0 ? Number((arrived / (panelOpens + arrived)).toFixed(4)) : null,
    };
  });

  const median = (values: number[]) => {
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const pullMedian = median(items.map((i) => i.pullRate ?? 0));
  const intentMedian = median(items.map((i) => i.intentRate ?? 0));

  // Strictly greater than, not >=. With small sample sizes, rates cluster on
  // round numbers (0%, 100%) and often tie exactly at the median -- with >=,
  // every tied item lands on the "high" side of both axes at once, which is
  // how a whole 5-product catalog could all classify as "hotspot" together.
  const classified = items.map((i) => {
    const pull = (i.pullRate ?? 0) > pullMedian;
    const intent = (i.intentRate ?? 0) > intentMedian;
    const quadrant = pull && intent ? "hotspot" : pull && !intent ? "attracts_but_disappoints" : !pull && intent ? "hidden_gem" : "dead_weight";
    return { ...i, quadrant };
  });

  return Response.json({
    experimentId,
    source,
    bucketSize: BUCKET,
    layers,
    gazeRays,
    impressionRays,
    tabFlows,
    items: classified,
    thresholds: { pullMedian, intentMedian },
    region: registry?.region ?? null,
  });
}

const COMPARED: { key: keyof ComponentMetrics; label: string }[] = [
  { key: "impressions", label: "impressions" },
  { key: "approaches", label: "approaches" },
  { key: "gazeSeconds", label: "gaze seconds" },
  { key: "interactions", label: "interactions" },
  { key: "panelOpens", label: "panel opens" },
  { key: "ctaClicks", label: "CTA clicks" },
  { key: "sightlineRate", label: "sightline rate" },
  { key: "engagementRate", label: "engagement rate" },
  { key: "intentRate", label: "intent rate" },
];
const RATE_KEYS = new Set(["sightlineRate", "engagementRate", "intentRate"]);

export async function compare(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const source = (url.searchParams.get("source") ?? "all") as SourceFilter;
  if (!before || !after) {
    return Response.json({ error: "before and after experiment ids are required" }, { status: 400 });
  }

  const beforeMetrics = new Map((await componentMetrics(env, before, source)).map((m) => [m.componentId, m]));
  const afterMetrics = new Map((await componentMetrics(env, after, source)).map((m) => [m.componentId, m]));
  const beforeSessions = Math.max(1, await sessionCount(env, before, source));
  const afterSessions = Math.max(1, await sessionCount(env, after, source));

  const registry = await getRegistryData(env);
  const titleOf = new Map(registry?.components.map((c) => [c.componentId, c.title]) ?? []);
  const componentIds = new Set([...beforeMetrics.keys(), ...afterMetrics.keys()]);

  const components = [...componentIds].sort().map((componentId) => {
    const b = beforeMetrics.get(componentId);
    const a = afterMetrics.get(componentId);
    const changes = COMPARED.map((metric) => {
      const rawBefore = (b?.[metric.key] as number | null) ?? null;
      const rawAfter = (a?.[metric.key] as number | null) ?? null;
      const isRate = RATE_KEYS.has(metric.key as string);
      const normBefore = rawBefore === null ? null : isRate ? rawBefore : rawBefore / beforeSessions;
      const normAfter = rawAfter === null ? null : isRate ? rawAfter : rawAfter / afterSessions;
      const pctChange =
        normBefore === null || normAfter === null || normBefore === 0
          ? null
          : (normAfter - normBefore) / normBefore;
      return {
        metric: metric.label,
        key: metric.key,
        isRate,
        rawBefore,
        rawAfter,
        perSessionBefore: normBefore === null ? null : Number(normBefore.toFixed(4)),
        perSessionAfter: normAfter === null ? null : Number(normAfter.toFixed(4)),
        pctChange: pctChange === null ? null : Number(pctChange.toFixed(4)),
      };
    });
    return { componentId, title: titleOf.get(componentId) ?? componentId, changes };
  });

  const experiment = await env.DB.prepare(
    `SELECT id, hypothesis, plan_json, status FROM experiments WHERE id = ?`,
  )
    .bind(after)
    .first<{ id: string; hypothesis: string | null; plan_json: string | null; status: string }>();

  let touched: string[] = [];
  if (experiment?.plan_json) {
    const plan = JSON.parse(experiment.plan_json) as { ops?: Record<string, unknown>[] };
    touched = (plan.ops ?? []).map((op) => String(op.componentId ?? op.componentIdA ?? "")).filter(Boolean);
  }

  return Response.json({
    before,
    after,
    source,
    beforeSessions,
    afterSessions,
    hypothesis: experiment?.hypothesis ?? null,
    status: experiment?.status ?? null,
    touchedComponents: touched,
    components,
  });
}
