import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

// Secrets live in the repo root .env.local, one level above this Next app.
const rootEnv = path.resolve(process.cwd(), "..", ".env.local");
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv, quiet: true });
}

export const env = {
  backendAuthToken: process.env.BACKEND_AUTH_TOKEN ?? "",
  workerUrl: process.env.WORKER_URL?.replace(/\/$/, "") ?? "",
  tunnelUrl: process.env.TUNNEL_URL ?? "",
  shopifyDomain: process.env.SHOPIFY_STORE_DOMAIN ?? "",
  shopifyAdminToken: process.env.SHOPIFY_ADMIN_TOKEN ?? "",
  shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  // Optional: only needed for automated (non-MCP) asset upload during
  // Create Storefront. See README "Bring your own Roblox game".
  robloxApiKey: process.env.ROBLOX_API_KEY ?? "",
  robloxCreatorId: process.env.ROBLOX_CREATOR_ID ?? "",
};

export function requireAuth(request: Request): { ok: true } | { ok: false; response: Response } {
  if (!env.backendAuthToken) {
    return {
      ok: false,
      response: Response.json(
        { error: "server misconfigured: BACKEND_AUTH_TOKEN not loaded" },
        { status: 500 },
      ),
    };
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== env.backendAuthToken) {
    return { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  }
  return { ok: true };
}
