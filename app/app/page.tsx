"use client";

import { useEffect, useMemo, useState } from "react";
import type { Analytics, ComponentRow } from "@/lib/types";
import { FunnelTable } from "@/components/FunnelTable";
import { ExperimentPanel } from "@/components/ExperimentPanel";
import { StoreHeat3D } from "@/components/StoreHeat3D";
import { ExperimentCompare } from "@/components/ExperimentCompare";
import { Card, SectionHeader, Stat, InfoTip } from "@/components/ui";
import { Sidebar } from "@/components/Sidebar";

const SECTIONS = [
  { id: "overview", label: "Funnel overview" },
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
  const [experimentId, setExperimentId] = useState<string | null>(null);
  const [active, setActive] = useState("overview");

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const query = new URLSearchParams({ heatmap: "1", source: "live" });
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
    // Every tick re-runs the full funnel + heatmap aggregation over the events
    // table; 5s was hammering D1 far faster than a demo's numbers actually move.
    const id = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [experimentId]);

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

  const navGroups = [
    [{ key: "create-storefront", label: "Create Storefront", href: "/create-storefront" }],
    SECTIONS.map((s) => ({ key: s.id, label: s.label, active: active === s.id, onClick: () => jump(s.id) })),
  ];

  return (
    <div className="flex min-h-screen">
      <Sidebar groups={navGroups} placeName={data?.place?.name} gameId={data?.place?.gameId}>
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] text-[var(--rbx-dim)]">
            Experiment
            <InfoTip align="left" text="Filter the dashboard to one storefront layout." />
          </div>
          <select
            value={experimentId ?? ""}
            onChange={(e) => setExperimentId(e.target.value || null)}
            className="rbx-select w-full rounded-[8px] px-2.5 py-2 text-[13px]"
          >
            <option value="">All experiments</option>
            {(data?.experiments ?? []).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      </Sidebar>

      <main className="min-w-0 flex-1 px-6 py-6 lg:px-10">
        <h1 className="mb-6 text-[28px] font-bold leading-tight">Storefront analytics</h1>

        {error && (
          <Card className="mb-5">
            <p className="text-sm text-red-400">read failed: {error}</p>
          </Card>
        )}

        {data && data.hasStorefront === false && (
          <Card className="mb-5">
            <SectionHeader title="No storefront yet" />
            <p className="text-sm text-[var(--rbx-dim)]">
              This place has no displays built yet.{" "}
              <a href="/create-storefront" className="font-semibold text-[var(--rbx-text)] underline">
                Go to Create Storefront
              </a>{" "}
              to fetch your Shopify catalog and build one.
            </p>
          </Card>
        )}

        {data && data.hasStorefront !== false && (
          <>
            <Card id="overview" className="mb-5">
              <SectionHeader
                title="Funnel"
                info="Seven stages, where a normal store has about three. Each drop-off points at a different fix."
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

            <Card className="mb-5">
              <SectionHeader
                title="Funnel by product"
                info="Amber marks a product starved of impressions, or one that is seen but not approached. Every column has its own info tooltip explaining how it's calculated."
              />
              <FunnelTable rows={data.components} />
            </Card>

            <Card id="space" className="mb-5">
              <SectionHeader
                title="Attention in space"
                info="Where players walked, looked from, and stopped. Traffic spreads along the walk; attention pools tightly where people actually stop."
              />
                <StoreHeat3D source="live" experimentId={experimentId} />
            </Card>

            <div id="result" className="mb-5">
              <ExperimentCompare experiments={data.experiments} source="live" />
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

export type { ComponentRow };
