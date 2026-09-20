import { env, requireAuth } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Roblox's StorefrontSetup poller hits this every 5s to claim a queued build job. */
export async function GET(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  if (!env.workerUrl) {
    return Response.json({ pending: false });
  }

  const response = await fetch(`${env.workerUrl}/storefront/pending`, {
    headers: { Authorization: `Bearer ${env.backendAuthToken}` },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  return Response.json(body, { status: response.status });
}
