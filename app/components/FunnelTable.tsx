"use client";

import { useState } from "react";
import type { ComponentRow } from "@/lib/types";

type SortKey = keyof ComponentRow;

const COLUMNS: { key: SortKey; label: string; hint?: string; format?: (r: ComponentRow) => string }[] =
  [
    { key: "title", label: "PRODUCT" },
    { key: "trafficRank", label: "RANK", hint: "slot traffic rank, 1 = busiest" },
    { key: "impressions", label: "IMPR", hint: "sessions that saw it at all" },
    { key: "approaches", label: "APPR", hint: "sessions that walked to it" },
    { key: "gazeSeconds", label: "GAZE s", hint: "seconds actually looking at it" },
    { key: "interactions", label: "INTER", hint: "prompt triggers" },
    { key: "panelOpens", label: "PANEL", hint: "panel opens" },
    { key: "panelActiveSeconds", label: "ACTIVE s", hint: "panel open AND being used" },
    { key: "ctaClicks", label: "CTA" },
    {
      key: "sightlineRate",
      label: "SIGHT",
      hint: "approaches / impressions — placement problem?",
      format: (r) => pct(r.sightlineRate),
    },
    {
      key: "engagementRate",
      label: "ENGAGE",
      hint: "interactions / approaches — presentation problem?",
      format: (r) => pct(r.engagementRate),
    },
    {
      key: "depthRate",
      label: "DEPTH",
      hint: "panel opens / interactions — display overpromising?",
      format: (r) => pct(r.depthRate),
    },
    {
      key: "intentRate",
      label: "INTENT",
      hint: "CTA clicks / panel opens — product or price problem?",
      format: (r) => pct(r.intentRate),
    },
  ];

function pct(v: number | null): string {
  if (v === null) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

export function FunnelTable({ rows }: { rows: ComponentRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("impressions");
  const [asc, setAsc] = useState(false);

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "number" && typeof bv === "number") return asc ? av - bv : bv - av;
    return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });

  if (rows.length === 0) {
    return <p className="text-xs text-neutral-500">No events yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded border border-neutral-800">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-[#17171a] text-left text-neutral-500">
            {COLUMNS.map((col) => (
              <th
                key={String(col.key)}
                title={col.hint}
                onClick={() => {
                  if (col.key === sortKey) setAsc(!asc);
                  else {
                    setSortKey(col.key);
                    setAsc(false);
                  }
                }}
                className="cursor-pointer whitespace-nowrap px-2 py-2 font-normal tracking-wider hover:text-neutral-200"
              >
                {col.label}
                {sortKey === col.key && <span className="text-neutral-600">{asc ? " ^" : " v"}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            // Lots of people saw it and did not walk over: a placement problem.
            const weakSightline = row.sightlineRate !== null && row.sightlineRate < 0.45;
            const starved = row.impressions < 120;
            return (
              <tr key={row.componentId} className="border-t border-neutral-800/70">
                {COLUMNS.map((col) => {
                  const raw = col.format ? col.format(row) : row[col.key];
                  const value =
                    typeof raw === "number" ? Number(raw.toFixed(1)).toLocaleString() : String(raw);
                  const highlight =
                    (col.key === "sightlineRate" && weakSightline) ||
                    (col.key === "impressions" && starved);
                  return (
                    <td
                      key={String(col.key)}
                      className={`whitespace-nowrap px-2 py-2 ${
                        col.key === "title" ? "text-neutral-200" : "text-neutral-400"
                      } ${highlight ? "bg-amber-500/10 text-amber-300" : ""}`}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-2 py-2 text-[10px] text-neutral-600">
        Amber = starved of impressions, or seen but not approached. Hover a header for what the
        column means.
      </p>
    </div>
  );
}
