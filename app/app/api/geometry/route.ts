import { db } from "@/lib/db";
import { env, requireAuth } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type Geometry = {
  bounds: { min: number[]; max: number[] };
  boxes: { p: number[]; s: number[]; r: number[]; c: string; t: number }[];
  spawns: { name: string; p: number[] }[];
};

export async function readGeometry(): Promise<Geometry | null> {
  if (env.workerUrl) {
    const res = await fetch(`${env.workerUrl}/geometry`, {
      headers: { Authorization: `Bearer ${env.backendAuthToken}` },
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as Geometry) : null;
  }
  const row = db().prepare(`SELECT value FROM kv WHERE key = 'geometry'`).get() as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as Geometry) : null;
}

export async function GET() {
  const geometry = await readGeometry();
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

  if (env.workerUrl) {
    const response = await fetch(`${env.workerUrl}/geometry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.backendAuthToken}` },
      body: JSON.stringify(body),
    });
    return Response.json(await response.json(), { status: response.status });
  }

  db()
    .prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES ('geometry', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(body), Date.now() / 1000);

  return Response.json({ ok: true, boxes: body.boxes.length });
}
