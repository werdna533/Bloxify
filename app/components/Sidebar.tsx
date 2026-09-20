"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

export type NavItem = {
  key: string;
  label: string;
  href?: string;
  onClick?: () => void;
  active?: boolean;
};

/**
 * Shared shell so every page (Overview, Create Storefront, ...) has the same
 * brand block and nav, instead of each page re-implementing it slightly
 * differently. Pages own their own nav item groups (some are same-page scroll
 * jumps, some are real routes) and can pass page-specific controls, like the
 * experiment filter, as children. Groups render as visually separate blocks
 * (own divider) rather than one flat list, so "Create Storefront" reads as a
 * different kind of action than the analytics scroll-jumps. The brand block
 * doubles as "which place is this" once we know it: the square becomes that
 * Roblox game's real thumbnail and the name becomes the place's own name,
 * rather than a static "Bloxify" that never says which game is connected.
 */
export function Sidebar({
  groups,
  children,
  placeName,
  gameId,
}: {
  groups: NavItem[][];
  children?: ReactNode;
  placeName?: string;
  gameId?: number;
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!gameId) {
      setThumbnailUrl(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/game-thumbnail?universeId=${gameId}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { imageUrl?: string | null } | null) => {
        if (!cancelled) setThumbnailUrl(body?.imageUrl ?? null);
      })
      .catch(() => {
        if (!cancelled) setThumbnailUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  return (
    <aside className="sticky top-0 hidden h-screen w-[264px] shrink-0 flex-col overflow-y-auto border-r border-[var(--rbx-line)] px-4 py-5 lg:flex">
      <div className="flex items-center gap-3 pb-4">
        <div
          className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[10px] text-[15px] font-bold"
          style={{ background: "var(--rbx-accent)" }}
        >
          {thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            "BX"
          )}
        </div>
        <span className="min-w-0 flex-1 truncate text-[19px] font-bold">{placeName || "Bloxify"}</span>
      </div>

      {groups.map((items, i) => (
        <div key={i} className="border-t border-[var(--rbx-line)] pt-4 pb-1">
          {items.map((item) =>
            item.href ? (
              <Link key={item.key} href={item.href} className="rbx-nav-item" data-active={item.active}>
                {item.label}
              </Link>
            ) : (
              <button
                key={item.key}
                className="rbx-nav-item"
                data-active={item.active}
                onClick={item.onClick}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      ))}

      {children}
    </aside>
  );
}
