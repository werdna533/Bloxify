import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  if (env.workerUrl) {
    const response = await fetch(`${env.workerUrl}/experiments/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.backendAuthToken}` },
    });
    return Response.json(await response.json(), { status: response.status });
  }

  const row = db().prepare(`SELECT status FROM experiments WHERE id = ?`).get(id) as
    | { status: string }
    | undefined;
  if (!row) return Response.json({ error: `unknown experiment ${id}` }, { status: 404 });

  if (row.status === "applying" || row.status === "rolling_back") {
    return Response.json(
      { error: `experiment is ${row.status} — wait for it to finish before deleting` },
      { status: 409 },
    );
  }

  db().prepare(`DELETE FROM experiments WHERE id = ?`).run(id);
  return Response.json({ ok: true, id });
}
