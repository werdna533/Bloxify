"use client";

import { useEffect, useMemo, useState } from "react";
import type { Analytics, ComponentRow } from "@/lib/types";
import { StoreMap } from "@/components/StoreMap";
import { FunnelTable } from "@/components/FunnelTable";
import { ExperimentPanel } from "@/components/ExperimentPanel";
import { StoreHeat3D } from "@/components/StoreHeat3D";
import { ExperimentCompare } from "@/components/ExperimentCompare";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "space", label: "Attention in space" },
  { id: "result", label: "Experiment result" },
  { id: "experiment", label: "Run an experiment" },
];

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

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--rbx-line)] px-3 py-4 lg:flex">
        <div className="mb-4 flex items-center gap-2 px-2">
          <div
            className="grid h-7 w-7 place-items-center rounded-[6px] font-bold"
            style={{ background: "var(--rbx-accent)" }}
          >
            S
          </div>
          <span className="text-[15px] font-bold tracking-[0.1em]">SHELFSENSE</span>
        </div>

        <div className="mb-3 flex items-center justify-between rounded-[8px] px-2 py-2 text-sm"
          style={{ background: "var(--rbx-overlay)" }}>
          <span className="truncate text-[var(--rbx-dim)]">HTN_26</span>
          <span className="rbx-pill" style={{ background: "var(--rbx-overlay-strong)" }}>
            {data?.experimentId ?? "live"}
          </span>
        </div>

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

        <div className="my-3 border-t border-[var(--rbx-line)]" />

        <div className="px-2">
          <div className="rbx-label mb-1.5">DATA SOURCE</div>
          <div className="flex gap-1">
            {(["all", "sim", "live"] as const).map((o) => (
              <button
                key={o}
                onClick={() => setSource(o)}
                className="flex-1 rounded-[6px] px-2 py-1 text-[11px] font-semibold uppercase"
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

        <div className="mt-4 px-2">
          <div className="rbx-label mb-1.5">EXPERIMENT</div>
          <select
            value={experimentId ?? ""}
            onChange={(e) => setExperimentId(e.target.value || null)}
            className="w-full rounded-[6px] px-2 py-1.5 text-[12px]"
            style={{ background: "var(--rbx-overlay)", color: "var(--rbx-text)" }}
          >
            <option value="">All experiments (mixed)</option>
            {(data?.experiments ?? []).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          {!experimentId && (
            <p className="mt-1.5 text-[10px] leading-4 text-[var(--rbx-faint)]">
              Mixing experiments blends different store layouts into one number.
            </p>
          )}
        </div>

        <div className="mt-auto px-2 pt-6">
          <Provenance data={data} />
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-6 py-6 lg:px-9">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[28px] font-bold leading-tight">Storefront analytics</h1>
            <p className="mt-0.5 text-sm text-[var(--rbx-dim)]">
              What players do around your products, and what to change about it.
            </p>
          </div>
        </header>

        {error && (
          <div className="rbx-card mb-5 p-4 text-sm text-red-400">read failed: {error}</div>
        )}

        {data && (
          <>
            <section id="overview" className="rbx-card mb-5 p-5">
              <SectionTitle>Funnel</SectionTitle>
              <div className="mt-4 flex flex-wrap items-start gap-x-3 gap-y-4">
                <Stat label="IMPRESSIONS" value={totals.impressions} hint="saw it" />
                <Arrow />
                <Stat label="APPROACHES" value={totals.approaches} hint="walked to it" />
                <Arrow />
                <Stat label="INTERACTIONS" value={totals.interactions} hint="touched it" />
                <Arrow />
                <Stat label="PANEL OPENS" value={totals.panelOpens} hint="wanted more" />
                <Arrow />
                <Stat label="CTA CLICKS" value={totals.ctaClicks} hint="wanted it" />
                <Arrow />
                <Stat label="PURCHASES" value={totals.purchases} hint="bought it" />
              </div>
            </section>

            <div className="mb-5 grid gap-5 xl:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
              <section className="rbx-card p-5">
                <SectionTitle>Store map</SectionTitle>
                <div className="mt-3">
                  <StoreMap
                    slots={data.slots}
                    components={data.components}
                    heatmap={data.heatmap ?? []}
                  />
                </div>
              </section>

              <section className="rbx-card min-w-0 p-5">
                <SectionTitle>Funnel by product</SectionTitle>
                <div className="mt-3">
                  <FunnelTable rows={data.components} />
                </div>
              </section>
            </div>

            <section id="space" className="rbx-card mb-5 p-5">
              <SectionTitle>Attention in space</SectionTitle>
              <p className="mb-3 mt-0.5 text-xs text-[var(--rbx-dim)]">
                Where players walked, looked from, and stopped.
              </p>
              <StoreHeat3D source={source} experimentId={experimentId} />
            </section>

            <section id="result" className="mb-5">
              <ExperimentCompare experiments={data.experiments} source={source} />
            </section>

            <section id="experiment" className="mb-10">
              <ExperimentPanel />
            </section>
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
    <div className="space-y-2 text-[11px]">
      <div>
        <div className="font-semibold text-amber-400">SEEDED SIMULATION</div>
        <div className="text-[var(--rbx-faint)]">
          {sim ? `${sim.sessions.toLocaleString()} sessions` : "none"}
        </div>
      </div>
      <div>
        <div className="font-semibold text-emerald-400">LIVE SESSIONS</div>
        <div className="text-[var(--rbx-faint)]">
          {live ? `${live.sessions.toLocaleString()} sessions` : "none"}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[15px] font-bold">{children}</h2>;
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="min-w-[96px]">
      <div className="rbx-label">{label}</div>
      <div className="text-[26px] font-bold leading-tight">{value.toLocaleString()}</div>
      <div className="text-[11px] text-[var(--rbx-faint)]">{hint}</div>
    </div>
  );
}

function Arrow() {
  return <div className="self-center pt-4 text-[var(--rbx-faint)]">&rarr;</div>;
}

export type { ComponentRow };
