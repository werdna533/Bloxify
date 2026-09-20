import { env, requireAuth } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Roblox's StorefrontSetup poller calls this once it finishes building (or fails). */
export async function POST(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  if (!env.workerUrl) {
    return Response.json({ ok: false, error: "no Worker configured" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const response = await fetch(`${env.workerUrl}/storefront/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.backendAuthToken}` },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => ({}));
  return Response.json(responseBody, { status: response.status });
}
