"use client";

import { useCallback, useEffect, useState } from "react";
import type { Experiment, Plan, Validation } from "@/lib/types";

type Insight = {
  plan: Plan;
  validation: Validation;
  model: string;
};

const STAGES = ["draft", "queued", "applying", "done"];

export function ExperimentPanel() {
  const [insight, setInsight] = useState<Insight | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/experiments", { cache: "no-store" });
    if (res.ok) setExperiments(((await res.json()) as { experiments: Experiment[] }).experiments);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const analyze = async () => {
    setBusy("analyze");
    setError(null);
    setInsight(null);
    setSavedId(null);
    try {
      const res = await fetch("/api/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "all" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setInsight(json as Insight);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!insight) return;
    setBusy("save");
    try {
      const res = await fetch("/api/experiments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hypothesis: insight.plan.hypothesis,
          plan: insight.plan,
          validation: insight.validation,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSavedId(json.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const apply = async (id: string) => {
    setBusy(`apply-${id}`);
    try {
      const res = await fetch(`/api/experiments/${id}/apply`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded border border-neutral-800 bg-[#141416] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs tracking-[0.25em] text-neutral-500">EXPERIMENT</h2>
        <button
          onClick={analyze}
          disabled={busy === "analyze"}
          className="rounded bg-neutral-200 px-4 py-1.5 text-xs font-semibold tracking-wider text-neutral-900 hover:bg-white disabled:opacity-40"
        >
          {busy === "analyze" ? "ANALYZING…" : "ANALYZE"}
        </button>
      </div>

      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}

      {insight && (
        <div className="mt-5 space-y-4 text-sm">
          <Field label="HYPOTHESIS">{insight.plan.hypothesis}</Field>
          <Field label="EVIDENCE">
            <ul className="space-y-1">
              {insight.plan.evidence.map((e, i) => (
                <li key={i} className="text-neutral-400">
                  &bull; {e}
                </li>
              ))}
            </ul>
          </Field>
          <div className="flex gap-10">
            <Field label="CONFIDENCE">
              <span className="uppercase">{insight.plan.confidence}</span>
            </Field>
            <Field label="MODEL">
              <span className="text-neutral-500">{insight.model}</span>
            </Field>
          </div>
          <Field label="EXPECTED EFFECT">{insight.plan.expectedEffect}</Field>

          <Field label="INTERVENTION">
            <ul className="space-y-1">
              {insight.validation.accepted.map((op, i) => (
                <li key={i} className="text-emerald-300">
                  &#10003; {describeOp(op)}
                </li>
              ))}
              {insight.validation.rejected.map((r, i) => (
                <li key={`r${i}`} className="text-red-400">
                  &#10007; {describeOp(r.op)}
                  <span className="text-neutral-500"> — validator refused: {r.reason}</span>
                </li>
              ))}
            </ul>
            {insight.validation.rejected.length > 0 && (
              <p className="mt-2 text-[10px] text-neutral-500">
                Rejected operations are never sent to Roblox.
              </p>
            )}
          </Field>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={save}
              disabled={busy !== null || insight.validation.accepted.length === 0 || savedId !== null}
              className="rounded border border-neutral-600 px-3 py-1.5 text-xs tracking-wider text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
            >
              {savedId ? `SAVED AS ${savedId}` : "SAVE AS EXPERIMENT"}
            </button>
            {savedId && (
              <button
                onClick={() => apply(savedId)}
                disabled={busy !== null}
                className="rounded bg-emerald-500 px-4 py-1.5 text-xs font-semibold tracking-wider text-neutral-950 hover:bg-emerald-400 disabled:opacity-40"
              >
                APPLY TO ROBLOX
              </button>
            )}
          </div>
        </div>
      )}

      {experiments.length > 0 && (
        <div className="mt-7 border-t border-neutral-800 pt-4">
          <h3 className="mb-3 text-[10px] tracking-[0.25em] text-neutral-600">LOG</h3>
          <ul className="space-y-2 text-xs">
            {experiments.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3">
                <span className="text-neutral-300">{e.id}</span>
                <StatusPill status={e.status} />
                <span className="min-w-0 flex-1 truncate text-neutral-500">{e.hypothesis}</span>
                {(e.status === "draft" || e.status === "failed") && (
                  <button
                    onClick={() => apply(e.id)}
                    disabled={busy !== null}
                    className="rounded border border-neutral-700 px-2 py-1 text-[10px] tracking-wider hover:bg-neutral-800"
                  >
                    APPLY
                  </button>
                )}
                {e.error && <span className="text-red-400">{e.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const index = STAGES.indexOf(status);
  const colour =
    status === "done"
      ? "bg-emerald-500/20 text-emerald-300"
      : status === "failed"
        ? "bg-red-500/20 text-red-300"
        : status === "applying"
          ? "bg-amber-500/20 text-amber-300"
          : "bg-neutral-700/40 text-neutral-400";
  return (
    <span className={`rounded px-2 py-0.5 text-[10px] tracking-wider ${colour}`}>
      {status.toUpperCase()}
      {index >= 0 && status !== "done" && (
        <span className="text-neutral-600"> {index + 1}/{STAGES.length}</span>
      )}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] tracking-[0.2em] text-neutral-600">{label}</div>
      <div className="text-neutral-200">{children}</div>
    </div>
  );
}

function describeOp(op: Record<string, unknown>): string {
  const name = String(op.op);
  switch (name) {
    case "move_to_slot":
      return `move ${op.componentId} to ${op.slotId}`;
    case "set_prominence":
      return `set ${op.componentId} prominence to ${op.level}`;
    case "set_cta_text":
      return `set ${op.componentId} CTA to "${op.text}"`;
    case "set_signage":
      return `set ${op.componentId} signage to "${op.text}"`;
    case "set_kind":
      return `change ${op.componentId} to a ${op.kind}`;
    case "enable_interaction":
      return `enable interaction on ${op.componentId}`;
    case "disable_interaction":
      return `disable interaction on ${op.componentId}`;
    case "swap_products":
      return `swap products between ${op.componentIdA} and ${op.componentIdB}`;
    default:
      return `${name} ${JSON.stringify(op)}`;
  }
}
