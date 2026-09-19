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
        `SELECT id, plan_json FROM experiments
         WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as { id: string; plan_json: string } | undefined;
    if (!row) return null;
    handle.prepare(`UPDATE experiments SET status = 'applying' WHERE id = ?`).run(row.id);
    return row;
  });

  const claimed = claim();
  if (!claimed) return Response.json({ pending: false });

  return Response.json({
    pending: true,
    experimentId: claimed.id,
    plan: JSON.parse(claimed.plan_json),
  });
}
