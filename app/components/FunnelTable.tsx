"use client";

import { useState } from "react";
import type { ComponentRow } from "@/lib/types";
import { InfoTip } from "@/components/ui";

type SortKey = keyof ComponentRow;

const COLUMNS: {
  key: SortKey;
  label: string;
  hint: string;
  format?: (r: ComponentRow, maxImpressions: number) => string;
}[] = [
  { key: "title", label: "Product", hint: "The product this row measures." },
  { key: "impressions", label: "Impressions", hint: "Sessions that saw this display at all, from any distance." },
  { key: "approaches", label: "Approaches", hint: "Sessions that walked within range of this display." },
  { key: "interactions", label: "Interactions", hint: "Times a player triggered this display's prompt." },
  { key: "panelOpens", label: "Panel opens", hint: "Times the product panel was opened for this item." },
  { key: "ctaClicks", label: "CTA clicks", hint: "Times a player pressed the buy button inside the panel." },
  {
    key: "sightlineRate",
    label: "Visibility",
    hint: "This product's impressions against the most-seen product's impressions -- a stand-in for what share of everyone who came in saw it, since total unique visitors isn't tracked directly.",
    format: (r, maxImpressions) => pct(maxImpressions > 0 ? r.impressions / maxImpressions : null),
  },
  {
    key: "engagementRate",
    label: "Engagement",
    hint: "Interactions divided by approaches. Low means people walk up but don't interact -- a presentation problem.",
    format: (r) => pct(r.engagementRate),
  },
];

function pct(v: number | null): string {
  if (v === null) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

export function FunnelTable({ rows }: { rows: ComponentRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("impressions");
  const [asc, setAsc] = useState(false);

  const maxImpressions = Math.max(0, ...rows.map((r) => r.impressions));

  // The Visibility column displays impressions/maxImpressions, not the raw
  // sightlineRate field it's keyed on -- sort by what's actually shown.
  const valueOf = (r: ComponentRow) => (sortKey === "sightlineRate" ? r.impressions : r[sortKey]);
  const sorted = [...rows].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "number" && typeof bv === "number") return asc ? av - bv : bv - av;
    return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });

  if (rows.length === 0) {
    return <p className="text-sm text-[var(--rbx-dim)]">No events yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-[10px] bg-[var(--rbx-overlay)]">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-[var(--rbx-overlay)] text-left text-[var(--rbx-dim)]">
            {COLUMNS.map((col) => (
              <th
                key={String(col.key)}
                onClick={() => {
                  if (col.key === sortKey) setAsc(!asc);
                  else {
                    setSortKey(col.key);
                    setAsc(false);
                  }
                }}
                className="cursor-pointer whitespace-nowrap px-2 py-2.5 font-normal hover:text-[var(--rbx-text)]"
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  <span onClick={(e) => e.stopPropagation()}>
                    <InfoTip text={col.hint} align="left" />
                  </span>
                  {sortKey === col.key && <span className="text-[var(--rbx-faint)]">{asc ? " ^" : " v"}</span>}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            // Lots of people saw it and did not walk over: a placement problem.
            // Flagged on Approaches, not Visibility -- Visibility now shows
            // impression share, a different signal from this approach ratio.
            const weakSightline = row.sightlineRate !== null && row.sightlineRate < 0.45;
            const starved = row.impressions < 120;
            return (
              <tr key={row.componentId} className="border-t border-[var(--rbx-line)]">
                {COLUMNS.map((col) => {
                  const raw = col.format ? col.format(row, maxImpressions) : row[col.key];
                  const value =
                    typeof raw === "number" ? Number(raw.toFixed(1)).toLocaleString() : String(raw);
                  const highlight =
                    (col.key === "approaches" && weakSightline) ||
                    (col.key === "impressions" && starved);
                  return (
                    <td
                      key={String(col.key)}
                      className={`whitespace-nowrap px-2 py-2.5 ${
                        col.key === "title" ? "text-[var(--rbx-text)]" : "text-[var(--rbx-dim)]"
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
    </div>
  );
}
