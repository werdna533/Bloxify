"use client";

import { useEffect, useState } from "react";

type Stats = {
  totals: { events: number; sessions: number };
  bySource: { source: string; n: number }[];
  byType: { type: string; n: number }[];
  latest: { ts: number; type: string; componentId: string | null; source: string }[];
  now: number;
};

export default function Home() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/stats", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Stats;
        if (!cancelled) {
          setStats(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 p-8 font-mono text-neutral-200">
      <h1 className="text-xl tracking-widest text-neutral-400">COMMERCE LAB — INGEST MONITOR</h1>
      <p className="mt-1 text-xs text-neutral-600">POC 2: backend read path, refreshes every 2s</p>

      {error && <p className="mt-6 text-red-400">read failed: {error}</p>}

      {stats && (
        <>
          <section className="mt-8 flex gap-10">
            <Stat label="EVENTS" value={stats.totals.events} />
            <Stat label="SESSIONS" value={stats.totals.sessions} />
          </section>

          <section className="mt-8">
            <h2 className="text-xs tracking-widest text-neutral-500">BY SOURCE</h2>
            <ul className="mt-2 text-sm">
              {stats.bySource.length === 0 && <li className="text-neutral-600">none yet</li>}
              {stats.bySource.map((row) => (
                <li key={row.source}>
                  <span className={row.source === "sim" ? "text-amber-400" : "text-emerald-400"}>
                    {row.source === "sim" ? "SEEDED SIMULATION" : "LIVE SESSION"}
                  </span>
                  <span className="text-neutral-500"> — {row.n}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-8">
            <h2 className="text-xs tracking-widest text-neutral-500">BY TYPE</h2>
            <ul className="mt-2 text-sm">
              {stats.byType.length === 0 && <li className="text-neutral-600">none yet</li>}
              {stats.byType.map((row) => (
                <li key={row.type}>
                  {row.type} <span className="text-neutral-500">— {row.n}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-8">
            <h2 className="text-xs tracking-widest text-neutral-500">LATEST 10</h2>
            <ul className="mt-2 text-xs text-neutral-400">
              {stats.latest.map((row, i) => (
                <li key={i}>
                  {new Date(row.ts * 1000).toLocaleTimeString()} · {row.type} ·{" "}
                  {row.componentId ?? "—"} ·{" "}
                  <span className={row.source === "sim" ? "text-amber-500" : "text-emerald-500"}>
                    {row.source}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs tracking-widest text-neutral-500">{label}</div>
      <div className="text-4xl text-neutral-100">{value.toLocaleString()}</div>
    </div>
  );
}
