"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Shared shells matching the Creator Dashboard: bordered cards, a heading with
 * an info affordance instead of a line of grey explanation under everything,
 * and label-over-value stats.
 */

export function Card({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`rounded-[14px] border border-[var(--rbx-line)] bg-[var(--rbx-surface)] p-6 ${className}`}
    >
      {children}
    </section>
  );
}

const TOOLTIP_WIDTH = 190;
const VIEWPORT_MARGIN = 12;

/**
 * Rendered through a portal at a fixed, viewport-computed position instead of
 * absolute-inside-the-trigger -- a tooltip inside a horizontally scrollable
 * table (FunnelTable) would otherwise be clipped by, or add to, that
 * container's scroll width. This way it always overlays on top, unclipped.
 */
export function InfoTip({ text, align = "center" }: { text: string; align?: "center" | "left" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawLeft = align === "left" ? rect.left : rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
    const left = Math.min(
      Math.max(rawLeft, VIEWPORT_MARGIN),
      window.innerWidth - TOOLTIP_WIDTH - VIEWPORT_MARGIN,
    );
    setPos({ top: rect.bottom + 6, left });
    setOpen(true);
  };
  const hide = () => setOpen(false);

  return (
    <span className="relative inline-flex items-center">
      <button
        ref={buttonRef}
        type="button"
        aria-label={text}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => (open ? hide() : show())}
        className="grid h-[18px] w-[18px] place-items-center rounded-full border border-[rgba(255,255,255,0.28)] text-[11px] leading-none text-[var(--rbx-dim)] hover:border-[rgba(255,255,255,0.55)] hover:text-white"
      >
        i
      </button>
      {open &&
        pos &&
        createPortal(
          <span
            role="tooltip"
            style={{ top: pos.top, left: pos.left, width: TOOLTIP_WIDTH }}
            className="fixed z-[999] rounded-[8px] border border-[var(--rbx-line)] bg-[#2A2C33] px-2.5 py-2 text-[12px] font-normal leading-5 text-[var(--rbx-text)] shadow-lg"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}

export function SectionHeader({
  title,
  info,
  right,
}: {
  title: string;
  info?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-[22px] font-bold leading-tight">
        {title}
        {info && <InfoTip text={info} />}
      </h2>
      {right}
    </div>
  );
}

export function Stat({
  label,
  value,
  info,
  delta,
  active,
}: {
  label: string;
  value: string | number;
  info?: string;
  delta?: number | null;
  active?: boolean;
}) {
  return (
    <div className={`min-w-[118px] pb-2 ${active ? "border-b-2 border-white" : ""}`}>
      <div className="flex items-center gap-1.5 text-[13px] text-[var(--rbx-dim)]">
        {label}
        {info && <InfoTip text={info} />}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[28px] font-bold leading-none">
          {typeof value === "number" ? value.toLocaleString() : value}
        </span>
        {delta !== undefined && delta !== null && <DeltaPill pct={delta} />}
      </div>
    </div>
  );
}

export function DeltaPill({ pct }: { pct: number }) {
  const up = pct > 0;
  const flat = Math.abs(pct) < 0.02;
  if (flat) {
    return (
      <span className="rounded-[6px] bg-[var(--rbx-overlay)] px-1.5 py-0.5 text-[12px] font-semibold text-[var(--rbx-dim)]">
        —
      </span>
    );
  }
  return (
    <span
      className="rounded-[6px] px-1.5 py-0.5 text-[12px] font-semibold"
      style={{
        background: up ? "rgba(34,197,94,0.16)" : "rgba(248,113,113,0.16)",
        color: up ? "#4ade80" : "#f87171",
      }}
    >
      {up ? "↑" : "↓"} {Math.abs(pct * 100).toFixed(1)}%
    </span>
  );
}
