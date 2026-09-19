/** Pulls the live storefront registry out of Studio and stores it on the backend. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { StudioBridge } from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "..", ".env.local"), quiet: true });

const BASE_URL = process.env.TUNNEL_URL ?? "http://localhost:3000";
const AUTH_TOKEN = process.env.BACKEND_AUTH_TOKEN ?? "";

const bridge = new StudioBridge();
await bridge.connect();

const result = await bridge.executeLuau(
  `return require(game.ServerScriptService.Storefront.StorefrontAPI).registry()`,
  "Edit",
);
await bridge.close();

if (result.isError) {
  console.error(`[registry] Studio returned an error: ${result.text}`);
  process.exit(1);
}

const registry = JSON.parse(result.text) as { slots: unknown[]; components: unknown[] };

const res = await fetch(`${BASE_URL}/api/registry`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_TOKEN}` },
  body: JSON.stringify(registry),
});

console.log(`[registry] backend replied ${res.status}: ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
