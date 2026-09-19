/**
 * Pushes backend URL + auth token from .env.local into Studio.
 *
 * The token is read from disk by this process and sent straight to Studio over
 * stdio MCP, so it never has to be typed into the place by hand or pasted
 * anywhere it could be captured.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { StudioBridge } from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "..", ".env.local"), quiet: true });

const BASE_URL = process.env.TUNNEL_URL ?? "";
const AUTH_TOKEN = process.env.BACKEND_AUTH_TOKEN ?? "";

if (!BASE_URL || !AUTH_TOKEN) {
  console.error("[sync-config] TUNNEL_URL or BACKEND_AUTH_TOKEN missing from .env.local");
  process.exit(1);
}
if (!/^[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/.test(AUTH_TOKEN)) {
  console.error("[sync-config] token contains characters that are unsafe to embed in Luau");
  process.exit(1);
}

const luau = `
local ServerScriptService = game:GetService("ServerScriptService")

local storefront = ServerScriptService:FindFirstChild("Storefront")
if not storefront then
  storefront = Instance.new("Folder")
  storefront.Name = "Storefront"
  storefront.Parent = ServerScriptService
end

local config = storefront:FindFirstChild("Config")
if not config then
  config = Instance.new("ModuleScript")
  config.Name = "Config"
  config.Parent = storefront
end

config.Source = [==[
return {
	BASE_URL = ${JSON.stringify(BASE_URL)},
	AUTH_TOKEN = ${JSON.stringify(AUTH_TOKEN)},
	PLACE_VERSION = 1,
	FLUSH_SECONDS = 3,
	FLUSH_EVENTS = 50,
	MAX_QUEUE = 500,
}
]==]

-- POC1 script embeds the token inline; patch it if it is still a placeholder.
local poc = ServerScriptService:FindFirstChild("POC1_Telemetry")
local pocPatched = false
if poc then
  local replaced = poc.Source:gsub("POC1_TOKEN_PLACEHOLDER", ${JSON.stringify(AUTH_TOKEN)})
  poc.Source = replaced
  pocPatched = poc.Source:find("POC1_TOKEN_PLACEHOLDER") == nil
end

return {
  configPath = config:GetFullName(),
  configBytes = #config.Source,
  pocPatched = pocPatched,
  baseUrl = ${JSON.stringify(BASE_URL)},
}
`;

const bridge = new StudioBridge();
await bridge.connect();
const tools = await bridge.listToolNames();
console.log(`[sync-config] connected, ${tools.length} tools available`);
const result = await bridge.executeLuau(luau, "Edit");
console.log(`[sync-config] ${result.isError ? "ERROR" : "ok"}: ${result.text}`);
await bridge.close();
process.exit(result.isError ? 1 : 0);
