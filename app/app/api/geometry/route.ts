import { db } from "@/lib/db";
import { requireAuth } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type Geometry = {
  bounds: { min: number[]; max: number[] };
  boxes: { p: number[]; s: number[]; r: number[]; c: string; t: number }[];
  spawns: { name: string; p: number[] }[];
};

export function readGeometry(): Geometry | null {
  const row = db().prepare(`SELECT value FROM kv WHERE key = 'geometry'`).get() as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as Geometry) : null;
}

export async function GET() {
  const geometry = readGeometry();
  if (!geometry) {
    return Response.json(
      { error: "no geometry yet — run `npx tsx bridge/export-geometry.ts`" },
      { status: 404 },
    );
  }
  return Response.json(geometry);
}

export async function POST(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const body = (await request.json()) as Geometry;
  if (!Array.isArray(body?.boxes)) {
    return Response.json({ error: "expected { boxes }" }, { status: 400 });
  }

  db()
    .prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES ('geometry', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(body), Date.now() / 1000);

  return Response.json({ ok: true, boxes: body.boxes.length });
}
