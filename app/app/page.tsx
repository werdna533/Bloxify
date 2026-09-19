"use client";

import { useEffect, useMemo, useState } from "react";
import type { Analytics, ComponentRow } from "@/lib/types";
import { StoreMap } from "@/components/StoreMap";
import { FunnelTable } from "@/components/FunnelTable";
import { ExperimentPanel } from "@/components/ExperimentPanel";
import { StoreHeat3D } from "@/components/StoreHeat3D";

export default function Lab() {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"all" | "sim" | "live">("all");

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/analytics?heatmap=1&source=${source}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Analytics;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [source]);

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

  return (
    <main className="min-h-screen bg-[#0f0f11] px-8 py-7 font-mono text-neutral-300">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-neutral-800 pb-4">
        <div>
          <h1 className="text-lg tracking-[0.3em] text-neutral-100">COMMERCE LAB</h1>
          <p className="mt-1 text-xs text-neutral-500">
            Roblox &times; Shopify &mdash; observe, understand, change, test
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <SourceToggle value={source} onChange={setSource} />
          {data && <Provenance data={data} />}
        </div>
      </header>

      {error && <p className="mt-6 text-red-400">read failed: {error}</p>}

      {data && (
        <>
          <section className="mt-6 flex flex-wrap gap-8">
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
          </section>

          <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            <section>
              <SectionTitle>STORE MAP</SectionTitle>
              <StoreMap
                slots={data.slots}
                components={data.components}
                heatmap={data.heatmap ?? []}
              />
            </section>

            <section className="min-w-0">
              <SectionTitle>FUNNEL BY PRODUCT</SectionTitle>
              <FunnelTable rows={data.components} />
            </section>
          </div>

          <section className="mt-10">
            <SectionTitle>ATTENTION IN SPACE</SectionTitle>
            <StoreHeat3D source={source} />
          </section>

          <section className="mt-10">
            <ExperimentPanel />
          </section>
        </>
      )}
    </main>
  );
}

function Provenance({ data }: { data: Analytics }) {
  const sim = data.sourceBreakdown.find((s) => s.source === "sim");
  const live = data.sourceBreakdown.find((s) => s.source === "live");
  return (
    <div className="text-right leading-5">
      <div>
        <span className="text-amber-400">SEEDED SIMULATION</span>{" "}
        <span className="text-neutral-500">
          {sim ? `${sim.sessions} sessions / ${sim.events} events` : "none"}
        </span>
      </div>
      <div>
        <span className="text-emerald-400">LIVE SESSIONS</span>{" "}
        <span className="text-neutral-500">
          {live ? `${live.sessions} sessions / ${live.events} events` : "none"}
        </span>
      </div>
    </div>
  );
}

function SourceToggle({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: "all" | "sim" | "live") => void;
}) {
  const options: ("all" | "sim" | "live")[] = ["all", "sim", "live"];
  return (
    <div className="flex overflow-hidden rounded border border-neutral-700">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`px-3 py-1 uppercase tracking-wider ${
            value === o ? "bg-neutral-200 text-neutral-900" : "text-neutral-400 hover:bg-neutral-800"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-xs tracking-[0.25em] text-neutral-500">{children}</h2>;
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div>
      <div className="text-[10px] tracking-[0.2em] text-neutral-500">{label}</div>
      <div className="text-3xl text-neutral-100">{value.toLocaleString()}</div>
      <div className="text-[10px] text-neutral-600">{hint}</div>
    </div>
  );
}

function Arrow() {
  return <div className="self-center pt-3 text-neutral-700">&rarr;</div>;
}

export type { ComponentRow };
