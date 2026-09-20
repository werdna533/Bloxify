"use client";

import { useEffect, useState } from "react";
import type { Analytics } from "@/lib/types";
import { Card, SectionHeader } from "@/components/ui";
import { Sidebar } from "@/components/Sidebar";

const SECTIONS = [
  { id: "overview", label: "Funnel overview" },
  { id: "space", label: "Attention in space" },
  { id: "result", label: "Experiment result" },
  { id: "experiment", label: "Run an experiment" },
];

type StorefrontStatus = { status?: "none" | "pending" | "claimed" | "done" | "failed"; error?: string };

export default function CreateStorefrontPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storefrontStatus, setStorefrontStatus] = useState<StorefrontStatus | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/analytics?source=live", { cache: "no-store" });
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
    // Only needed to notice hasStorefront flip to true once a build finishes --
    // /api/storefront/status (DO-backed, not D1) already covers the fast-moving
    // "is it building" state, so this can be much less frequent.
    const id = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const createStorefront = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/storefront/create", { method: "POST" });
      const body = (await res.json()) as StorefrontStatus & { error?: string };
      if (!res.ok) {
        setStorefrontStatus({ status: "failed", error: body.error });
        return;
      }
      setStorefrontStatus({ status: "pending" });
    } catch (e) {
      setStorefrontStatus({ status: "failed", error: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (data?.hasStorefront !== false) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/storefront/status", { cache: "no-store" });
        setStorefrontStatus((await res.json()) as StorefrontStatus);
      } catch {
        // A dead backend must not spam the console every 3s.
      }
    }, 3000);
    return () => clearInterval(id);
  }, [data?.hasStorefront]);

  const navGroups = [
    [{ key: "create-storefront", label: "Create Storefront", active: true }],
    SECTIONS.map((s) => ({ key: s.id, label: s.label, href: `/#${s.id}` })),
  ];

  const building = storefrontStatus?.status === "pending" || storefrontStatus?.status === "claimed";

  return (
    <div className="flex min-h-screen">
      <Sidebar groups={navGroups} placeName={data?.place?.name} gameId={data?.place?.gameId} />

      <main className="min-w-0 flex-1 px-6 py-6 lg:px-10">
        <h1 className="mb-6 text-[28px] font-bold leading-tight">Create Storefront</h1>

        {error && (
          <Card className="mb-5">
            <p className="text-sm text-red-400">read failed: {error}</p>
          </Card>
        )}

        {!data && !error && (
          <Card>
            <p className="text-sm text-[var(--rbx-dim)]">loading…</p>
          </Card>
        )}

        {data && data.hasStorefront !== false && (
          <Card>
            <SectionHeader title="This place already has a storefront" />
            <p className="text-sm text-[var(--rbx-dim)]">
              {data.place?.name ?? "This Roblox place"} already has displays built. Creating a second
              storefront isn&apos;t supported here — go back to{" "}
              <a href="/" className="font-semibold text-[var(--rbx-text)] underline">
                Overview
              </a>{" "}
              to see it.
            </p>
          </Card>
        )}

        {data && data.hasStorefront === false && (
          <Card>
            <SectionHeader
              title="Build a storefront from a blank place"
              info="Fetches your Shopify catalog, classifies each product into a display type (mannequin, plush stand, generic stand, or wall poster), computes a layout that clears the room's real geometry, and queues it for this place's own Roblox script to build. No Studio session required -- this runs through the Cloudflare Worker and a script already running in the place."
            />
            <button className="rbx-button" disabled={creating || building} onClick={createStorefront}>
              {creating
                ? "Queuing..."
                : storefrontStatus?.status === "pending"
                  ? "Waiting for Roblox to build it..."
                  : storefrontStatus?.status === "claimed"
                    ? "Building..."
                    : storefrontStatus?.status === "done"
                      ? "Built -- check Overview"
                      : "Create Storefront"}
            </button>
            {storefrontStatus?.status === "failed" && (
              <p className="mt-3 text-sm text-red-400">{storefrontStatus.error ?? "failed"}</p>
            )}
            {storefrontStatus?.status === "done" && (
              <p className="mt-3 text-sm text-emerald-400">
                Done —{" "}
                <a href="/" className="underline">
                  view it in Overview
                </a>
                .
              </p>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}
