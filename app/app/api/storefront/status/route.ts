import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The dashboard polls this while waiting for a queued layout to be built. */
export async function GET() {
  if (!env.workerUrl) {
    return Response.json({ status: "none" });
  }
  const response = await fetch(`${env.workerUrl}/storefront/status`, {
    headers: { Authorization: `Bearer ${env.backendAuthToken}` },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  return Response.json(body, { status: response.status });
}
