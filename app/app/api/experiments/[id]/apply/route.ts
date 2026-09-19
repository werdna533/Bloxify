import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  if (env.workerUrl) {
    const response = await fetch(`${env.workerUrl}/experiments/${id}/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.backendAuthToken}` },
    });
    return Response.json(await response.json(), { status: response.status });
  }

  const row = db().prepare(`SELECT id, status, plan_json FROM experiments WHERE id = ?`).get(id) as
    | { id: string; status: string; plan_json: string | null }
    | undefined;

  if (!row) return Response.json({ error: `unknown experiment ${id}` }, { status: 404 });
  if (!row.plan_json) return Response.json({ error: "experiment has no plan" }, { status: 400 });
  if (row.status === "applying") {
    return Response.json({ error: "already being applied" }, { status: 409 });
  }

  db().prepare(`UPDATE experiments SET status = 'queued', error = NULL WHERE id = ?`).run(id);
  return Response.json({ id, status: "queued" });
}
