export type Env = {
  DB: D1Database;
  SHOTS: R2Bucket;
  EXPERIMENT_RUN: DurableObjectNamespace;
  STOREFRONT_SETUP: DurableObjectNamespace;
  BACKEND_AUTH_TOKEN: string;
  OPENAI_API_KEY: string;
};

// Same Bearer-token check the Next.js backend uses (app/lib/env.ts requireAuth),
// so the Bridge, Roblox and simulate.ts keep working unchanged.
export function requireAuth(request: Request, env: Env): Response | null {
  if (!env.BACKEND_AUTH_TOKEN) {
    return Response.json({ error: "server misconfigured: BACKEND_AUTH_TOKEN not loaded" }, { status: 500 });
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== env.BACKEND_AUTH_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
