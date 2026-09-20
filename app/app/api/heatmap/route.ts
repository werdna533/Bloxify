import { db } from "@/lib/db";
import { componentMetrics, type SourceFilter } from "@/lib/metrics";
import { readRegistry } from "@/app/api/registry/route";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = 3; // studs

type Cell = { x: number; z: number; n: number; w?: number };

function sourceClause(source: SourceFilter): string {
  return source === "all" ? "" : `AND source = '${source}'`;
}

/**
 * Spatial layers plus a per-item hotspot read.
 *
 * "Hotspot" is deliberately two numbers rather than one: an item that pulls
 * people in but never converts needs a different fix from one nobody sees, and
 * a single blended score hides exactly that difference.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  if (env.workerUrl) {
    const response = await fetch(`${env.workerUrl}/heatmap${url.search}`, {
      headers: { Authorization: `Bearer ${env.backendAuthToken}` },
      cache: "no-store",
    });
    return Response.json(await response.json(), { status: response.status });
  }

  const experimentId = url.searchParams.get("experimentId");
  const source = (url.searchParams.get("source") ?? "all") as SourceFilter;
  const expClause = experimentId ? `AND experiment_id = @experimentId` : "";
  const src = sourceClause(source);
  const handle = db();

  const bucketed = (types: string[], weightField?: string): Cell[] => {
    const list = types.map((t) => `'${t}'`).join(",");
    const weight = weightField
      ? `COALESCE(SUM(json_extract(meta_json, '$.${weightField}')), 0)`
      : `0`;
    return handle
      .prepare(
        `SELECT CAST(x / ${BUCKET} AS INTEGER) * ${BUCKET} AS x,
                CAST(z / ${BUCKET} AS INTEGER) * ${BUCKET} AS z,
                COUNT(*) AS n,
                ${weight} AS w
         FROM events
         WHERE type IN (${list}) AND x IS NOT NULL ${expClause} ${src}
         GROUP BY 1, 2`,
      )
      .all({ experimentId }) as Cell[];
  };

  const layers = {
    traffic: bucketed(["path_point"]),
    attention: bucketed(["display_gaze"], "gazeSeconds"),
    approach: bucketed(["display_approach", "display_revisit"]),
    interaction: bucketed(["display_interacted"]),
    hesitation: bucketed(["display_hesitation"]),
  };

  // Individual sightlines, so the 3D view can draw what people looked at from
  // where rather than only where they stood.
  const gazeRays = handle
    .prepare(
      `SELECT x, y, z, component_id AS componentId,
              json_extract(meta_json, '$.gazeSeconds') AS seconds
       FROM events
       WHERE type = 'display_gaze' AND x IS NOT NULL AND component_id IS NOT NULL
         ${expClause} ${src}
       ORDER BY seconds DESC
       LIMIT 500`,
    )
    .all({ experimentId }) as { x: number; y: number; z: number; componentId: string; seconds: number }[];

  // Long-range sightlines: the places a display was visible from but not yet
  // walked to. This is the signal a 2D store cannot produce at all.
  const impressionRays = handle
    .prepare(
      `SELECT x, y, z, component_id AS componentId,
              json_extract(meta_json, '$.distance') AS distance
       FROM events
       WHERE type = 'display_impression' AND x IS NOT NULL AND component_id IS NOT NULL
         ${expClause} ${src}
       ORDER BY distance DESC
       LIMIT 400`,
    )
    .all({ experimentId }) as { x: number; y: number; z: number; componentId: string; distance: number }[];

  // Attention that arrived from a different display's panel.
  const tabFlows = handle
    .prepare(
      `SELECT json_extract(meta_json, '$.fromComponentId') AS source,
              json_extract(meta_json, '$.toComponentId')   AS target,
              COUNT(*) AS n
       FROM events
       WHERE type = 'panel_engaged'
         AND json_extract(meta_json, '$.toComponentId') IS NOT NULL
         ${expClause} ${src}
       GROUP BY 1, 2`,
    )
    .all({ experimentId }) as { source: string | null; target: string; n: number }[];

  const registry = await readRegistry();
  const metrics = componentMetrics(experimentId, source);
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

    // How magnetic it is once it has been seen at all.
    const pullRate = impressions > 0 ? approaches / impressions : null;
    // How long it holds someone who did walk over.
    const holdSeconds = approaches > 0 ? (m?.gazeSeconds ?? 0) / approaches : null;
    // Whether people who opened it actually wanted it.
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
      // Share of this item's panel attention that its own placement did not earn.
      borrowedShare:
        panelOpens + arrived > 0 ? Number((arrived / (panelOpens + arrived)).toFixed(4)) : null,
    };
  });

  // Split on the median rather than a fixed threshold: with five products a
  // fixed cut would just label everything the same thing.
  const median = (values: number[]) => {
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const pullMedian = median(items.map((i) => i.pullRate ?? 0));
  const intentMedian = median(items.map((i) => i.intentRate ?? 0));

  const classified = items.map((i) => {
    const pull = (i.pullRate ?? 0) >= pullMedian;
    const intent = (i.intentRate ?? 0) >= intentMedian;
    const quadrant =
      pull && intent
        ? "hotspot"
        : pull && !intent
          ? "attracts_but_disappoints"
          : !pull && intent
            ? "hidden_gem"
            : "dead_weight";
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
