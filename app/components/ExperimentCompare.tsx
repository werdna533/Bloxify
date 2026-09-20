"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTip } from "@/components/ui";

type Change = {
  metric: string;
  key: string;
  isRate: boolean;
  rawBefore: number | null;
  rawAfter: number | null;
  perSessionBefore: number | null;
  perSessionAfter: number | null;
  pctChange: number | null;
};

type Comparison = {
  before: string;
  after: string;
  beforeSessions: number;
  afterSessions: number;
  hypothesis: string | null;
  status: string | null;
  touchedComponents: string[];
  components: { componentId: string; title: string; changes: Change[] }[];
};

/**
 * The half of the loop that was missing: did the change actually do anything?
 * Counts are shown per session as well as raw, because two runs almost never
 * have the same number of sessions and raw counts would flatter the longer one.
 */
export function ExperimentCompare({
  experiments,
  source,
}: {
  experiments: string[];
  source: string;
}) {
  const [before, setBefore] = useState<string>("");
  const [after, setAfter] = useState<string>("");
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (experiments.length >= 2) {
      setBefore((b) => b || experiments[0]);
      setAfter((a) => a || experiments[experiments.length - 1]);
    }
  }, [experiments]);

  const load = useCallback(async () => {
    if (!before || !after || before === after) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/compare?before=${before}&after=${after}&source=${source}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as Comparison);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [before, after, source]);

  useEffect(() => {
    void load();
  }, [load]);

  // Detail starts open for whatever this plan actually touched -- that's the
  // interesting part -- and collapsed for everything else, so a five-product
  // store doesn't turn into five full tables on load.
  useEffect(() => {
    if (data) setExpanded(new Set(data.touchedComponents));
  }, [data]);

  const toggle = (componentId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(componentId)) next.delete(componentId);
      else next.add(componentId);
      return next;
    });
  };

  if (experiments.length < 2) {
    return (
      <div className="rbx-card p-5">
        <h2 className="text-[17px] font-bold">Experiment result</h2>
        <p className="mt-2 text-sm text-[var(--rbx-dim)]">
          Needs two experiments to compare. Run one and collect some sessions against it.
        </p>
      </div>
    );
  }

  const touched = new Set(data?.touchedComponents ?? []);
  const ordered = [...(data?.components ?? [])].sort((a, b) => {
    const at = touched.has(a.componentId) ? 0 : 1;
    const bt = touched.has(b.componentId) ? 0 : 1;
    return at - bt || a.title.localeCompare(b.title);
  });

  return (
    <div className="rbx-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[17px] font-bold">
          Experiment result
          <InfoTip align="left" text="Did the change do what the model expected? Compares real player behaviour from before an experiment was applied to after." />
        </h2>
        <div className="flex items-center gap-2 text-sm">
          <Picker value={before} onChange={setBefore} options={experiments} label="before" />
          <span className="text-[var(--rbx-faint)]">&rarr;</span>
          <Picker value={after} onChange={setAfter} options={experiments} label="after" />
        </div>
      </div>

      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
      {busy && !data && <p className="mt-4 text-xs text-[var(--rbx-faint)]">comparing…</p>}

      {data && (
        <>
          {data.hypothesis && (
            <div className="rbx-inset mt-4 p-3">
              <div className="rbx-label mb-1">What the model predicted</div>
              <p className="text-sm">{data.hypothesis}</p>
            </div>
          )}

          <div className="mt-4 space-y-4">
            {ordered.map((component) => {
              const isTouched = touched.has(component.componentId);
              const isOpen = expanded.has(component.componentId);
              return (
                <div
                  key={component.componentId}
                  className="rounded-[8px] p-3"
                  style={{
                    background: isTouched ? "var(--rbx-overlay-strong)" : "var(--rbx-overlay)",
                  }}
                >
                  <button
                    onClick={() => toggle(component.componentId)}
                    className="flex w-full items-center gap-2 text-left"
                  >
                    <span className="text-[var(--rbx-dim)]">{isOpen ? "▾" : "▸"}</span>
                    <span className="text-sm font-semibold">{component.title}</span>
                    {isTouched && (
                      <span
                        className="rbx-pill"
                        style={{ background: "var(--rbx-accent)", color: "#fff" }}
                      >
                        Changed by this plan
                      </span>
                    )}
                    <span className="ml-auto text-xs text-[var(--rbx-faint)]">
                      {isOpen ? "hide details" : "show details"}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[620px] border-collapse text-sm">
                        <thead>
                          <tr className="text-left text-[var(--rbx-faint)]">
                            <th className="py-1 pr-3 font-normal">metric</th>
                            <th className="py-1 pr-3 font-normal">before</th>
                            <th className="py-1 pr-3 font-normal">after</th>
                            <th className="py-1 pr-3 font-normal">per session</th>
                            <th className="py-1 font-normal">change</th>
                          </tr>
                        </thead>
                        <tbody>
                          {component.changes.map((c) => (
                            <tr key={c.key} className="border-t border-[var(--rbx-line)]">
                              <td className="py-1.5 pr-3 text-[var(--rbx-dim)]">{c.metric}</td>
                              <td className="py-1.5 pr-3">{fmt(c.rawBefore, c.isRate)}</td>
                              <td className="py-1.5 pr-3">{fmt(c.rawAfter, c.isRate)}</td>
                              <td className="py-1.5 pr-3 text-[var(--rbx-faint)]">
                                {c.isRate
                                  ? "—"
                                  : `${c.perSessionBefore ?? "—"} → ${c.perSessionAfter ?? "—"}`}
                              </td>
                              <td className="py-1.5">
                                <Delta pct={c.pctChange} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function fmt(value: number | null, isRate: boolean): string {
  if (value === null) return "—";
  if (isRate) return `${(value * 100).toFixed(0)}%`;
  return value >= 100 ? Math.round(value).toLocaleString() : String(value);
}

function Delta({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-[var(--rbx-faint)]">—</span>;
  const up = pct > 0;
  const flat = Math.abs(pct) < 0.02;
  const colour = flat ? "var(--rbx-faint)" : up ? "#4ade80" : "#f87171";
  return (
    <span style={{ color: colour }}>
      {flat ? "no change" : `${up ? "+" : ""}${(pct * 100).toFixed(0)}%`}
    </span>
  );
}

function Picker({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="rbx-label">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rbx-select rounded-[6px] px-2 py-1 text-sm"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
