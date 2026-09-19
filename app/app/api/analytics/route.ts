import { componentMetrics, heatmap, sourceBreakdown, experimentIds } from "@/lib/metrics";
import { readRegistry } from "@/app/api/registry/route";
import { env } from "@/lib/env";
import type { SourceFilter } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);

  if (env.workerUrl) {
    const response = await fetch(`${env.workerUrl}/analytics${url.search}`, {
      headers: { Authorization: `Bearer ${env.backendAuthToken}` },
      cache: "no-store",
    });
    return Response.json(await response.json(), { status: response.status });
  }

  const experimentId = url.searchParams.get("experimentId");
  const source = (url.searchParams.get("source") ?? "all") as SourceFilter;
  const wantHeatmap = url.searchParams.get("heatmap") === "1";

  const registry = await readRegistry();
  const metrics = componentMetrics(experimentId, source);
  const bySlot = new Map(registry?.components.map((c) => [c.componentId, c]) ?? []);
  const rankBySlot = new Map(registry?.slots.map((s) => [s.slotId, s.trafficRank]) ?? []);

  const rows = metrics.map((m) => {
    const component = bySlot.get(m.componentId);
    return {
      ...m,
      title: component?.title ?? m.componentId,
      price: component?.price ?? null,
      slotId: component?.slotId ?? null,
      trafficRank: component ? (rankBySlot.get(component.slotId) ?? null) : null,
      kind: component?.kind ?? null,
      prominence: component?.prominence ?? null,
    };
  });

  return Response.json({
    experimentId,
    source,
    experiments: experimentIds(),
    sourceBreakdown: sourceBreakdown(experimentId),
    slots: registry?.slots ?? [],
    place: registry?.place ?? null,
    components: rows,
    heatmap: wantHeatmap ? heatmap(experimentId, source) : undefined,
  });
}
