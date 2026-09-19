import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const handle = db();

  const totals = handle
    .prepare(`SELECT COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions FROM events`)
    .get() as { events: number; sessions: number };

  const bySource = handle
    .prepare(`SELECT source, COUNT(*) AS n FROM events GROUP BY source`)
    .all() as { source: string; n: number }[];

  const byType = handle
    .prepare(`SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC`)
    .all() as { type: string; n: number }[];

  const latest = handle
    .prepare(
      `SELECT ts, type, component_id AS componentId, source
       FROM events ORDER BY id DESC LIMIT 10`,
    )
    .all();

  return Response.json({ totals, bySource, byType, latest, now: Date.now() / 1000 });
}
