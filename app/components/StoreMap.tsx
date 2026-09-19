"use client";

import type { ComponentRow, Slot } from "@/lib/types";

/**
 * Top-down 2D map. The 3D view is the Roblox place itself — this is only
 * meant to make placement legible at a glance.
 */
export function StoreMap({
  slots,
  components,
  heatmap,
}: {
  slots: Slot[];
  components: ComponentRow[];
  heatmap: { x: number; z: number; n: number }[];
}) {
  if (slots.length === 0) {
    return (
      <p className="rounded border border-neutral-800 p-4 text-xs text-neutral-500">
        No registry yet. Run <code className="text-neutral-300">npx tsx bridge/pull-registry.ts</code>
      </p>
    );
  }

  const SPAWN = { x: -77, z: 0 };
  const xs = [...slots.map((s) => s.pos[0]), SPAWN.x, ...heatmap.map((h) => h.x)];
  const zs = [...slots.map((s) => s.pos[2]), SPAWN.z, ...heatmap.map((h) => h.z)];
  const pad = 14;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minZ = Math.min(...zs) - pad;
  const maxZ = Math.max(...zs) + pad;

  const width = 400;
  const height = Math.round((width * (maxZ - minZ)) / (maxX - minX));
  const sx = (x: number) => ((x - minX) / (maxX - minX)) * width;
  const sz = (z: number) => ((z - minZ) / (maxZ - minZ)) * height;

  const occupant = new Map(components.filter((c) => c.slotId).map((c) => [c.slotId as string, c]));
  const maxHeat = Math.max(1, ...heatmap.map((h) => h.n));
  const cell = Math.max(2, sx(minX + 2) - sx(minX));

  return (
    <div className="rounded border border-neutral-800 bg-[#141416] p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img">
        {heatmap.map((h, i) => (
          <rect
            key={i}
            x={sx(h.x)}
            y={sz(h.z)}
            width={cell}
            height={cell}
            fill="#38bdf8"
            opacity={0.06 + 0.5 * (h.n / maxHeat)}
          />
        ))}

        <circle cx={sx(SPAWN.x)} cy={sz(SPAWN.z)} r={5} fill="#22c55e" />
        <text
          x={sx(SPAWN.x) + 9}
          y={sz(SPAWN.z) + 4}
          fill="#4ade80"
          fontSize={9}
          fontFamily="monospace"
        >
          SPAWN
        </text>

        {slots.map((slot) => {
          const here = occupant.get(slot.slotId);
          const cx = sx(slot.pos[0]);
          const cy = sz(slot.pos[2]);
          const dim = !here;
          return (
            <g key={slot.slotId}>
              <circle
                cx={cx}
                cy={cy}
                r={here ? 11 : 7}
                fill={dim ? "#1f1f23" : "#27272e"}
                stroke={dim ? "#3f3f46" : "#a1a1aa"}
                strokeDasharray={dim ? "3 2" : undefined}
              />
              <text
                x={cx}
                y={cy + 3}
                textAnchor="middle"
                fill={dim ? "#52525b" : "#e4e4e7"}
                fontSize={9}
                fontFamily="monospace"
              >
                {slot.trafficRank}
              </text>
              <text
                x={cx}
                y={cy - 15}
                textAnchor="middle"
                fill="#71717a"
                fontSize={8}
                fontFamily="monospace"
              >
                {slot.slotId}
              </text>
              {here && (
                <text
                  x={cx}
                  y={cy + 23}
                  textAnchor="middle"
                  fill="#d4d4d8"
                  fontSize={8}
                  fontFamily="monospace"
                >
                  {here.title.replace(/^Waterloo /, "")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="mt-2 text-[10px] leading-4 text-neutral-600">
        Number in each slot is its traffic rank (1 = busiest corridor, 8 = dead corner). Dashed =
        empty. Blue wash is player path density.
      </p>
    </div>
  );
}
