import type { Env } from "./env";

/**
 * Ported from app/lib/metrics.ts. D1's API is async and binds positionally
 * (`?`) rather than better-sqlite3's sync `@name` style; the SQL itself is
 * unchanged; D1 is SQLite.
 */

export type SourceFilter = "sim" | "live" | "all";

export type ComponentMetrics = {
  componentId: string;
  productId: string | null;
  impressions: number;
  approaches: number;
  dwellSeconds: number;
  gazeSeconds: number;
  interactions: number;
  hesitations: number;
  panelOpens: number;
  panelActiveSeconds: number;
  ctaClicks: number;
  linkShows: number;
  purchases: number;
  sightlineRate: number | null;
  engagementRate: number | null;
  depthRate: number | null;
  intentRate: number | null;
  conversionRate: number | null;
  approachConcordance: number | null;
  avgInteractionDistance: number | null;
};

function sourceClause(source: SourceFilter): string {
  return source === "all" ? "" : `AND source = '${source}'`;
}

function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

export async function componentMetrics(
  env: Env,
  experimentId: string | null,
  source: SourceFilter = "all",
): Promise<ComponentMetrics[]> {
  const expClause = experimentId ? `AND experiment_id = ?` : "";
  const src = sourceClause(source);
  const binds = experimentId ? [experimentId] : [];

  const rows = (
    await env.DB.prepare(
      `SELECT
        component_id AS componentId,
        MAX(product_id) AS productId,
        COUNT(DISTINCT CASE WHEN type = 'display_impression' THEN session_id END) AS impressions,
        COUNT(DISTINCT CASE WHEN type = 'display_approach'   THEN session_id END) AS approaches,
        COALESCE(SUM(CASE WHEN type = 'display_dwell'
          THEN json_extract(meta_json, '$.dwellSeconds') END), 0) AS dwellSeconds,
        COALESCE(SUM(CASE WHEN type = 'display_gaze'
          THEN json_extract(meta_json, '$.gazeSeconds') END), 0) AS gazeSeconds,
        SUM(CASE WHEN type = 'display_interacted'  THEN 1 ELSE 0 END) AS interactions,
        SUM(CASE WHEN type = 'display_hesitation'  THEN 1 ELSE 0 END) AS hesitations,
        SUM(CASE WHEN type = 'panel_opened'        THEN 1 ELSE 0 END) AS panelOpens,
        COALESCE(SUM(CASE WHEN type = 'panel_closed'
          THEN json_extract(meta_json, '$.activeSeconds') END), 0) AS panelActiveSeconds,
        SUM(CASE WHEN type = 'panel_cta_clicked'   THEN 1 ELSE 0 END) AS ctaClicks,
        SUM(CASE WHEN type = 'shopify_link_shown'  THEN 1 ELSE 0 END) AS linkShows,
        AVG(CASE WHEN type = 'display_gaze'
          THEN json_extract(meta_json, '$.distance') END) AS avgInteractionDistance,
        AVG(CASE WHEN type = 'display_approach'
          THEN CASE WHEN json_extract(meta_json, '$.approachBearing') < 60 THEN 1.0 ELSE 0.0 END
        END) AS approachConcordance
      FROM events
      WHERE component_id IS NOT NULL ${expClause} ${src}
      GROUP BY component_id
      ORDER BY component_id`,
    )
      .bind(...binds)
      .all()
  ).results as Record<string, number | string | null>[];

  const purchaseRows = (
    await env.DB.prepare(`SELECT product_id AS productId, COUNT(*) AS n FROM orders GROUP BY product_id`).all()
  ).results as { productId: string | null; n: number }[];
  const purchasesByProduct = new Map(purchaseRows.map((r) => [r.productId, r.n]));

  return rows.map((raw) => {
    const r = raw as unknown as ComponentMetrics & { [k: string]: number };
    const purchases = purchasesByProduct.get(r.productId as unknown as string) ?? 0;
    return {
      componentId: String(r.componentId),
      productId: (r.productId as unknown as string) ?? null,
      impressions: r.impressions,
      approaches: r.approaches,
      dwellSeconds: Number(r.dwellSeconds.toFixed(1)),
      gazeSeconds: Number(r.gazeSeconds.toFixed(1)),
      interactions: r.interactions,
      hesitations: r.hesitations,
      panelOpens: r.panelOpens,
      panelActiveSeconds: Number(r.panelActiveSeconds.toFixed(1)),
      ctaClicks: r.ctaClicks,
      linkShows: r.linkShows,
      purchases,
      sightlineRate: rate(r.approaches, r.impressions),
      engagementRate: rate(r.interactions, r.approaches),
      depthRate: rate(r.panelOpens, r.interactions),
      intentRate: rate(r.ctaClicks, r.panelOpens),
      conversionRate: rate(purchases, r.ctaClicks),
      approachConcordance:
        r.approachConcordance === null ? null : Number(Number(r.approachConcordance).toFixed(4)),
      avgInteractionDistance:
        r.avgInteractionDistance === null ? null : Number(Number(r.avgInteractionDistance).toFixed(2)),
    };
  });
}

export async function sourceBreakdown(env: Env, experimentId: string | null) {
  const expClause = experimentId ? `WHERE experiment_id = ?` : "";
  const binds = experimentId ? [experimentId] : [];
  return (
    await env.DB.prepare(
      `SELECT source, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
       FROM events ${expClause} GROUP BY source`,
    )
      .bind(...binds)
      .all()
  ).results as { source: string; events: number; sessions: number }[];
}

/** Chronological, not alphabetical — "exp_baseline" sorts after "exp_03" by name. */
export async function experimentIds(env: Env): Promise<string[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT experiment_id AS id, MIN(ts) AS firstSeen FROM events
       WHERE experiment_id IS NOT NULL GROUP BY experiment_id ORDER BY firstSeen ASC`,
    ).all()
  ).results as { id: string }[];
  return rows.map((r) => r.id);
}

export type Cell = { x: number; z: number; n: number; w?: number };

export async function bucketedLayer(
  env: Env,
  types: string[],
  experimentId: string | null,
  source: SourceFilter,
  bucket: number,
  weightField?: string,
): Promise<Cell[]> {
  const list = types.map((t) => `'${t}'`).join(",");
  const weight = weightField ? `COALESCE(SUM(json_extract(meta_json, '$.${weightField}')), 0)` : `0`;
  const expClause = experimentId ? `AND experiment_id = ?` : "";
  const binds = experimentId ? [experimentId] : [];
  return (
    await env.DB.prepare(
      `SELECT CAST(x / ${bucket} AS INTEGER) * ${bucket} AS x,
              CAST(z / ${bucket} AS INTEGER) * ${bucket} AS z,
              COUNT(*) AS n, ${weight} AS w
       FROM events
       WHERE type IN (${list}) AND x IS NOT NULL ${expClause} ${sourceClause(source)}
       GROUP BY 1, 2`,
    )
      .bind(...binds)
      .all()
  ).results as Cell[];
}

export async function sessionCount(env: Env, experimentId: string, source: SourceFilter): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE experiment_id = ? ${sourceClause(source)}`,
  )
    .bind(experimentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
