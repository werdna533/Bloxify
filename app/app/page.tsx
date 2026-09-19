"use client";

import { useEffect, useMemo, useState } from "react";
import type { Analytics, ComponentRow } from "@/lib/types";
import { StoreMap } from "@/components/StoreMap";
import { FunnelTable } from "@/components/FunnelTable";
import { ExperimentPanel } from "@/components/ExperimentPanel";
import { StoreHeat3D } from "@/components/StoreHeat3D";
import { ExperimentCompare } from "@/components/ExperimentCompare";
import { Card, SectionHeader, Stat, InfoTip } from "@/components/ui";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "space", label: "Attention in space" },
  { id: "result", label: "Experiment result" },
  { id: "experiment", label: "Run an experiment" },
];

const FUNNEL = [
  { key: "impressions", label: "Impressions", info: "Sessions where a display entered view from a distance, unobstructed. This is the difference between never seeing a product and seeing it and walking past." },
  { key: "approaches", label: "Approaches", info: "Sessions where a player walked within 12 studs of the display." },
  { key: "interactions", label: "Interactions", info: "Times a player triggered the display's prompt." },
  { key: "panelOpens", label: "Panel opens", info: "Times the product panel was opened. Deliberate consideration, unlike standing nearby." },
  { key: "ctaClicks", label: "CTA clicks", info: "Times a player pressed the buy button inside the panel." },
  { key: "purchases", label: "Purchases", info: "Real Shopify orders matched back to a session by its single-use claim code." },
] as const;

export default function Lab() {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"all" | "sim" | "live">("all");
  const [experimentId, setExperimentId] = useState<string | null>(null);
  const [active, setActive] = useState("overview");

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const query = new URLSearchParams({ heatmap: "1", source });
        if (experimentId) query.set("experimentId", experimentId);
        const res = await fetch(`/api/analytics?${query}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Analytics;
        if (cancelled) return;
        setData(json);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [source, experimentId]);

  const totals = useMemo(() => {
    const rows = data?.components ?? [];
    return rows.reduce(
      (acc, r) => ({
        impressions: acc.impressions + r.impressions,
        approaches: acc.approaches + r.approaches,
        interactions: acc.interactions + r.interactions,
        panelOpens: acc.panelOpens + r.panelOpens,
        ctaClicks: acc.ctaClicks + r.ctaClicks,
        purchases: acc.purchases + r.purchases,
      }),
      { impressions: 0, approaches: 0, interactions: 0, panelOpens: 0, ctaClicks: 0, purchases: 0 },
    );
  }, [data]);

  const jump = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const placeName = data?.place?.name ?? "—";

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[264px] shrink-0 flex-col overflow-y-auto border-r border-[var(--rbx-line)] px-4 py-5 lg:flex">
        <div className="flex items-center gap-3 pb-4">
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] text-[15px] font-bold"
            style={{ background: "var(--rbx-accent)" }}
          >
            {placeName.slice(0, 2).toUpperCase()}
          </div>
          <span className="min-w-0 flex-1 truncate text-[19px] font-bold">{placeName}</span>
          <span className="text-[var(--rbx-faint)]">⋮</span>
        </div>

        <div className="border-t border-[var(--rbx-line)] pt-4">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className="rbx-nav-item"
              data-active={active === s.id}
              onClick={() => jump(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="mt-6 border-t border-[var(--rbx-line)] pt-4">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] text-[var(--rbx-dim)]">
            Data source
            <InfoTip text="Seeded simulation is synthetic traffic used to fill the funnel before thousands of real encounters exist. Live sessions are real players. They are never blended silently." />
          </div>
          <div className="flex gap-1.5">
            {(["all", "sim", "live"] as const).map((o) => (
              <button
                key={o}
                onClick={() => setSource(o)}
                className="flex-1 rounded-[8px] px-2 py-1.5 text-[12px] font-semibold uppercase"
                style={
                  source === o
                    ? { background: "var(--rbx-accent)", color: "#fff" }
                    : { background: "var(--rbx-overlay)", color: "var(--rbx-dim)" }
                }
              >
                {o}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] text-[var(--rbx-dim)]">
            Experiment
            <InfoTip text="Each experiment is a different store layout. Selecting All mixes layouts together, which blends numbers that are not comparable." />
          </div>
          <select
            value={experimentId ?? ""}
            onChange={(e) => setExperimentId(e.target.value || null)}
            className="w-full rounded-[8px] px-2.5 py-2 text-[13px]"
            style={{ background: "var(--rbx-overlay)", color: "var(--rbx-text)" }}
          >
            <option value="">All experiments</option>
            {(data?.experiments ?? []).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-auto pt-6">
          <Provenance data={data} />
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-6 py-6 lg:px-10">
        <h1 className="mb-6 text-[28px] font-bold leading-tight">Storefront analytics</h1>

        {error && (
          <Card className="mb-5">
            <p className="text-sm text-red-400">read failed: {error}</p>
          </Card>
        )}

        {data && (
          <>
            <Card id="overview" className="mb-5">
              <SectionHeader
                title="Funnel"
                info="Seven stages, where a normal store has about three. Each drop-off points at a different fix."
                right={
                  <span className="rounded-[8px] bg-[var(--rbx-overlay)] px-3 py-1.5 text-[13px] text-[var(--rbx-dim)]">
                    {experimentId ?? "All experiments"}
                  </span>
                }
              />
              <div className="flex flex-wrap items-start gap-x-5 gap-y-5">
                {FUNNEL.map((f, i) => (
                  <div key={f.key} className="flex items-start gap-5">
                    <Stat
                      label={f.label}
                      value={totals[f.key as keyof typeof totals]}
                      info={f.info}
                    />
                    {i < FUNNEL.length - 1 && (
                      <span className="pt-7 text-[var(--rbx-faint)]">&rarr;</span>
                    )}
                  </div>
                ))}
              </div>
            </Card>

            <div className="mb-5 grid gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
              <Card>
                <SectionHeader
                  title="Store map"
                  info="Top-down view of the eight anchor slots. The number in each slot is its traffic rank, 1 being the busiest corridor. The blue wash is player path density."
                />
                <StoreMap
                  slots={data.slots}
                  components={data.components}
                  heatmap={data.heatmap ?? []}
                />
              </Card>

              <Card className="min-w-0">
                <SectionHeader
                  title="Funnel by product"
                  info="Amber marks a product starved of impressions, or one that is seen but not approached. Hover any column header for what it measures."
                />
                <FunnelTable rows={data.components} />
              </Card>
            </div>

            <Card id="space" className="mb-5">
              <SectionHeader
                title="Attention in space"
                info="Where players walked, looked from, and stopped. Traffic spreads along the walk; attention pools tightly where people actually stop."
              />
              <StoreHeat3D source={source} experimentId={experimentId} />
            </Card>

            <div id="result" className="mb-5">
              <ExperimentCompare experiments={data.experiments} source={source} />
            </div>

            <div id="experiment" className="mb-10">
              <ExperimentPanel />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Provenance({ data }: { data: Analytics | null }) {
  const sim = data?.sourceBreakdown.find((s) => s.source === "sim");
  const live = data?.sourceBreakdown.find((s) => s.source === "live");
  return (
    <div className="space-y-3 text-[13px]">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-amber-400">Seeded</span>
        <span className="text-[var(--rbx-faint)]">
          {sim ? sim.sessions.toLocaleString() : "0"}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="font-semibold text-emerald-400">Live</span>
        <span className="text-[var(--rbx-faint)]">
          {live ? live.sessions.toLocaleString() : "0"}
        </span>
      </div>
    </div>
  );
}

export type { ComponentRow };
