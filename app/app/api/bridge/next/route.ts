import { db } from "@/lib/db";
import { requireAuth } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Bridge polls this. Claims one queued experiment and hands over its plan. */
export async function GET(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const handle = db();
  const claim = handle.transaction(() => {
    const row = handle
      .prepare(
        `SELECT id, plan_json, snapshot_before_json, status FROM experiments
         WHERE status IN ('queued', 'rollback_queued') ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as
      | { id: string; plan_json: string; snapshot_before_json: string | null; status: string }
      | undefined;
    if (!row) return null;
    const next = row.status === "rollback_queued" ? "rolling_back" : "applying";
    handle.prepare(`UPDATE experiments SET status = ? WHERE id = ?`).run(next, row.id);
    return row;
  });

  const claimed = claim();
  if (!claimed) return Response.json({ pending: false });

  if (claimed.status === "rollback_queued") {
    return Response.json({
      pending: true,
      action: "restore",
      experimentId: claimed.id,
      snapshot: claimed.snapshot_before_json,
    });
  }

  return Response.json({
    pending: true,
    action: "apply",
    experimentId: claimed.id,
    plan: JSON.parse(claimed.plan_json),
  });
}
