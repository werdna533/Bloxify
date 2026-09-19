import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Queues a one-call restore from the snapshot taken before this apply. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const row = db()
    .prepare(`SELECT id, status, snapshot_before_json FROM experiments WHERE id = ?`)
    .get(id) as { id: string; status: string; snapshot_before_json: string | null } | undefined;

  if (!row) return Response.json({ error: `unknown experiment ${id}` }, { status: 404 });
  if (!row.snapshot_before_json) {
    return Response.json(
      { error: "no snapshot stored for this experiment — nothing to roll back to" },
      { status: 400 },
    );
  }

  db().prepare(`UPDATE experiments SET status = 'rollback_queued', error = NULL WHERE id = ?`).run(id);
  return Response.json({ id, status: "rollback_queued" });
}
