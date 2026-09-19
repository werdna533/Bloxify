import { db } from "@/lib/db";

/**
 * Every number the dashboard and the AI see comes from here. Defined once so
 * "dwell" means the same thing in the funnel table, the prompt and the
 * experiment delta.
 *
 * Three time metrics, never summed:
 *   dwellSeconds  - near it            (weak)
 *   gazeSeconds   - looking at it      (medium)
 *   panelActiveSeconds - panel open and being used (strong)
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
  if (source === "all") return "";
  return `AND source = '${source}'`;
}

function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

export function componentMetrics(
  experimentId: string | null,
  source: SourceFilter = "all",
): ComponentMetrics[] {
  const handle = db();
  const expClause = experimentId ? `AND experiment_id = @experimentId` : "";
  const src = sourceClause(source);

  const rows = handle
    .prepare(
      `
      SELECT
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
      ORDER BY component_id
      `,
    )
    .all({ experimentId }) as Record<string, number | string | null>[];

  // Purchases are attributed through the orders table, not the event stream.
  const purchaseRows = handle
    .prepare(
      `SELECT product_id AS productId, COUNT(*) AS n FROM orders GROUP BY product_id`,
    )
    .all() as { productId: string | null; n: number }[];
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
        r.avgInteractionDistance === null
          ? null
          : Number(Number(r.avgInteractionDistance).toFixed(2)),
    };
  });
}

/** 2-stud buckets over path_point positions. This is the heatmap. */
export function heatmap(
  experimentId: string | null,
  source: SourceFilter = "all",
): { x: number; z: number; n: number }[] {
  const expClause = experimentId ? `AND experiment_id = @experimentId` : "";
  return db()
    .prepare(
      `
      SELECT CAST(x / 2 AS INTEGER) * 2 AS x,
             CAST(z / 2 AS INTEGER) * 2 AS z,
             COUNT(*) AS n
      FROM events
      WHERE type = 'path_point' AND x IS NOT NULL ${expClause} ${sourceClause(source)}
      GROUP BY 1, 2
      ORDER BY n DESC
      `,
    )
    .all({ experimentId }) as { x: number; z: number; n: number }[];
}

export function sourceBreakdown(experimentId: string | null) {
  const expClause = experimentId ? `WHERE experiment_id = @experimentId` : "";
  return db()
    .prepare(
      `SELECT source, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
       FROM events ${expClause} GROUP BY source`,
    )
    .all({ experimentId }) as { source: string; events: number; sessions: number }[];
}

/**
 * Chronological, not alphabetical. "exp_baseline" sorts after "exp_03" by name,
 * which would default a before/after comparison to running backwards.
 */
export function experimentIds(): string[] {
  return (
    db()
      .prepare(
        `SELECT experiment_id AS id, MIN(ts) AS firstSeen FROM events
         WHERE experiment_id IS NOT NULL
         GROUP BY experiment_id
         ORDER BY firstSeen ASC`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
}
