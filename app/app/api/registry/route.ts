import { db } from "@/lib/db";
import { env, requireAuth } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type Registry = {
  slots: {
    slotId: string;
    trafficRank: number;
    visibilityScore?: number | null;
    pos: number[];
    facing: number[];
  }[];
  components: {
    componentId: string;
    productId: string;
    title: string;
    price: number;
    slotId: string;
    kind: string;
    prominence: number;
    interactionEnabled: boolean;
    ctaText?: string;
    signageText?: string;
    pos: number[];
    facing: number[];
  }[];
  kinds: string[];
  experimentId: string;
  place?: { name: string; placeId: number; gameId: number };
};

/**
 * Single source of truth for the live registry, used both by this route's GET
 * and by every other server route that needs it (insights, products). Reads
 * the Worker/D1 when configured so nothing reads a stale local copy once
 * writes have moved there.
 */
export async function readRegistry(): Promise<(Registry & { updatedAt: number }) | null> {
  if (env.workerUrl) {
    const res = await fetch(`${env.workerUrl}/registry`, {
      headers: { Authorization: `Bearer ${env.backendAuthToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as Registry & { updatedAt: number };
  }

  const row = db().prepare(`SELECT value, updated_at FROM kv WHERE key = 'registry'`).get() as
    | { value: string; updated_at: number }
    | undefined;
  if (!row) return null;
  return { ...(JSON.parse(row.value) as Registry), updatedAt: row.updated_at };
}

export async function GET() {
  const registry = await readRegistry();
  if (!registry) {
    return Response.json(
      { error: "no registry yet — run `npx tsx bridge/pull-registry.ts` to pull it from Studio" },
      { status: 404 },
    );
  }
  return Response.json(registry);
}

export async function POST(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const body = (await request.json()) as Registry;
  if (!Array.isArray(body?.slots) || !Array.isArray(body?.components)) {
    return Response.json({ error: "expected { slots, components }" }, { status: 400 });
  }

  if (env.workerUrl) {
    const response = await fetch(`${env.workerUrl}/registry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.backendAuthToken}` },
      body: JSON.stringify(body),
    });
    return Response.json(await response.json(), { status: response.status });
  }

  db()
    .prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES ('registry', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(body), Date.now() / 1000);

  return Response.json({
    ok: true,
    slots: body.slots.length,
    components: body.components.length,
  });
}
