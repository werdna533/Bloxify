import { db } from "@/lib/db";
import { componentMetrics, type ComponentMetrics, type SourceFilter } from "@/lib/metrics";
import { readRegistry } from "@/app/api/registry/route";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The "test" half of observe → understand → change → test.
 *
 * Compares one experiment's metrics against another's. Without this the loop
 * stops at "we changed something" and never answers whether it worked.
 */

const COMPARED: { key: keyof ComponentMetrics; label: string; higherIsBetter: boolean }[] = [
  { key: "impressions", label: "impressions", higherIsBetter: true },
  { key: "approaches", label: "approaches", higherIsBetter: true },
  { key: "gazeSeconds", label: "gaze seconds", higherIsBetter: true },
  { key: "interactions", label: "interactions", higherIsBetter: true },
  { key: "panelOpens", label: "panel opens", higherIsBetter: true },
  { key: "ctaClicks", label: "CTA clicks", higherIsBetter: true },
  { key: "sightlineRate", label: "sightline rate", higherIsBetter: true },
  { key: "engagementRate", label: "engagement rate", higherIsBetter: true },
  { key: "intentRate", label: "intent rate", higherIsBetter: true },
];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const source = (url.searchParams.get("source") ?? "all") as SourceFilter;

  if (!before || !after) {
    return Response.json({ error: "before and after experiment ids are required" }, { status: 400 });
  }

  if (env.workerUrl) {
    const response = await fetch(`${env.workerUrl}/compare${url.search}`, {
      headers: { Authorization: `Bearer ${env.backendAuthToken}` },
      cache: "no-store",
    });
    return Response.json(await response.json(), { status: response.status });
  }

  const beforeMetrics = new Map(componentMetrics(before, source).map((m) => [m.componentId, m]));
  const afterMetrics = new Map(componentMetrics(after, source).map((m) => [m.componentId, m]));

  // Sessions differ between runs, so raw counts are not comparable on their
  // own. Rates are; counts get a per-session normalisation alongside them.
  const sessionsOf = (experimentId: string) =>
    (
      db()
        .prepare(
          `SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE experiment_id = ?
           ${source === "all" ? "" : `AND source = '${source}'`}`,
        )
        .get(experimentId) as { n: number }
    ).n;

  const beforeSessions = Math.max(1, sessionsOf(before));
  const afterSessions = Math.max(1, sessionsOf(after));

  const componentIds = new Set([...beforeMetrics.keys(), ...afterMetrics.keys()]);
  const registry = await readRegistry();
  const titleOf = new Map(registry?.components.map((c) => [c.componentId, c.title]) ?? []);

  const RATE_KEYS = new Set(["sightlineRate", "engagementRate", "intentRate"]);

  const components = [...componentIds].sort().map((componentId) => {
    const b = beforeMetrics.get(componentId);
    const a = afterMetrics.get(componentId);

    const changes = COMPARED.map((metric) => {
      const rawBefore = (b?.[metric.key] as number | null) ?? null;
      const rawAfter = (a?.[metric.key] as number | null) ?? null;
      const isRate = RATE_KEYS.has(metric.key as string);

      // Counts are per-session so a longer run does not look like a win.
      const normBefore =
        rawBefore === null ? null : isRate ? rawBefore : rawBefore / beforeSessions;
      const normAfter = rawAfter === null ? null : isRate ? rawAfter : rawAfter / afterSessions;

      const delta =
        normBefore === null || normAfter === null ? null : normAfter - normBefore;
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
        delta: delta === null ? null : Number(delta.toFixed(4)),
        pctChange: pctChange === null ? null : Number(pctChange.toFixed(4)),
      };
    });

    return {
      componentId,
      title: titleOf.get(componentId) ?? componentId,
      changes,
    };
  });

  // What the plan actually said it was doing, so the result can be read
  // against the prediction rather than against hindsight.
  const experiment = db()
    .prepare(`SELECT id, hypothesis, plan_json, result_json, status FROM experiments WHERE id = ?`)
    .get(after) as
    | { id: string; hypothesis: string | null; plan_json: string | null; status: string }
    | undefined;

  let touched: string[] = [];
  if (experiment?.plan_json) {
    const plan = JSON.parse(experiment.plan_json) as { ops?: Record<string, unknown>[] };
    touched = (plan.ops ?? [])
      .map((op) => String(op.componentId ?? op.componentIdA ?? ""))
      .filter(Boolean);
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
