import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function nextExperimentId(): string {
  const row = db()
    .prepare(`SELECT COUNT(*) AS n FROM experiments`)
    .get() as { n: number };
  return `exp_${String(row.n + 1).padStart(2, "0")}`;
}

export async function GET() {
  const rows = db()
    .prepare(`SELECT * FROM experiments ORDER BY created_at DESC LIMIT 25`)
    .all();
  return Response.json({ experiments: rows });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    hypothesis?: string;
    name?: string;
    plan?: Record<string, unknown>;
    validation?: Record<string, unknown>;
  };

  if (!body.plan) return Response.json({ error: "plan is required" }, { status: 400 });

  const id = nextExperimentId();
  // Store only the operations the validator accepted, never the raw model output.
  const accepted = (body.validation?.accepted as unknown[]) ?? [];
  const planForRoblox = { experimentId: id, ops: accepted };

  db()
    .prepare(
      `INSERT INTO experiments (id, name, hypothesis, status, created_at, plan_json, result_json)
       VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
    )
    .run(
      id,
      body.name ?? id,
      body.hypothesis ?? null,
      Date.now() / 1000,
      JSON.stringify(planForRoblox),
      JSON.stringify({ proposed: body.plan, validation: body.validation ?? null }),
    );

  return Response.json({ id, status: "draft", ops: accepted.length });
}
