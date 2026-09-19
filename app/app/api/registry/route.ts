import { db } from "@/lib/db";
import { requireAuth } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type Registry = {
  slots: { slotId: string; trafficRank: number; pos: number[]; facing: number[] }[];
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

export function readRegistry(): (Registry & { updatedAt: number }) | null {
  const row = db().prepare(`SELECT value, updated_at FROM kv WHERE key = 'registry'`).get() as
    | { value: string; updated_at: number }
    | undefined;
  if (!row) return null;
  return { ...(JSON.parse(row.value) as Registry), updatedAt: row.updated_at };
}

export async function GET() {
  const registry = readRegistry();
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
