import { db } from "@/lib/db";
import { requireAuth } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const body = (await request.json()) as {
    experimentId: string;
    stage?: "snapshot" | "applied" | "captured" | "failed" | "rolled_back";
    snapshot?: string;
    result?: Record<string, unknown>;
    imageBefore?: string;
    imageAfter?: string;
    error?: string;
  };

  if (!body.experimentId) {
    return Response.json({ error: "experimentId is required" }, { status: 400 });
  }

  const handle = db();
  const existing = handle
    .prepare(`SELECT id, result_json FROM experiments WHERE id = ?`)
    .get(body.experimentId) as { id: string; result_json: string | null } | undefined;
  if (!existing) {
    return Response.json({ error: `unknown experiment ${body.experimentId}` }, { status: 404 });
  }

  // The snapshot arrives before the apply, so rollback is possible even if the
  // apply then fails halfway.
  if (body.snapshot) {
    handle
      .prepare(`UPDATE experiments SET snapshot_before_json = ? WHERE id = ?`)
      .run(body.snapshot, body.experimentId);
  }
  if (body.imageBefore) {
    handle.prepare(`UPDATE experiments SET image_before = ? WHERE id = ?`).run(body.imageBefore, body.experimentId);
  }
  if (body.imageAfter) {
    handle.prepare(`UPDATE experiments SET image_after = ? WHERE id = ?`).run(body.imageAfter, body.experimentId);
  }

  if (body.result) {
    const merged = { ...(existing.result_json ? JSON.parse(existing.result_json) : {}), applyResult: body.result };
    handle
      .prepare(`UPDATE experiments SET result_json = ? WHERE id = ?`)
      .run(JSON.stringify(merged), body.experimentId);
  }

  if (body.stage) {
    const status =
      body.stage === "failed"
        ? "failed"
        : body.stage === "captured"
          ? "done"
          : body.stage;
    handle
      .prepare(`UPDATE experiments SET status = ?, error = ? WHERE id = ?`)
      .run(status, body.error ?? null, body.experimentId);
  }

  return Response.json({ ok: true });
}
