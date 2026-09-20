/**
 * Exports a simplified box representation of the store region from Studio so
 * the dashboard can render the space in 3D.
 *
 * Boxes only, deliberately: the point is a recognisable shell to read a
 * heatmap against, not a faithful copy of the place. The real thing is Roblox.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { StudioBridge } from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "..", ".env.local"), quiet: true });

const BASE_URL = process.env.TUNNEL_URL ?? "http://localhost:3000";
const AUTH_TOKEN = process.env.BACKEND_AUTH_TOKEN ?? "";

const LUAU = `
local CollectionService = game:GetService("CollectionService")

-- Bounds come from the StorefrontRegion part any place using this package
-- must tag, plus generous vertical padding -- not hardcoded per-room numbers,
-- so this script works on someone else's place, not just this one.
local region = CollectionService:GetTagged("StorefrontRegion")[1]
if not region then
	error("export-geometry: no Part tagged StorefrontRegion in this place")
end
local half = region.Size / 2
local MIN = region.Position - Vector3.new(half.X + 20, 20, half.Z + 20)
local MAX = region.Position + Vector3.new(half.X + 20, 30, half.Z + 20)
local MAX_PARTS = 500

-- Skip anything too small to help a reader orient, plus our own storefront
-- (drawn separately from the registry) and the arena's team forcefields.
local SKIP_ANCESTORS = { "Storefront", "Forcefields" }

local function skipped(part)
	for _, name in ipairs(SKIP_ANCESTORS) do
		if part:FindFirstAncestor(name) then return true end
	end
	return false
end

local boxes = {}
for _, p in ipairs(workspace:GetDescendants()) do
	if p:IsA("BasePart") and not skipped(p) then
		local pos = p.Position
		local inside = pos.X >= MIN.X and pos.X <= MAX.X
			and pos.Z >= MIN.Z and pos.Z <= MAX.Z
			and pos.Y >= MIN.Y and pos.Y <= MAX.Y
		local volume = p.Size.X * p.Size.Y * p.Size.Z
		if inside and volume >= 4 and p.Transparency < 0.95 then
			local rx, ry, rz = p.CFrame:ToEulerAnglesXYZ()
			table.insert(boxes, {
				p = { math.floor(pos.X * 10) / 10, math.floor(pos.Y * 10) / 10, math.floor(pos.Z * 10) / 10 },
				s = { math.floor(p.Size.X * 10) / 10, math.floor(p.Size.Y * 10) / 10, math.floor(p.Size.Z * 10) / 10 },
				r = { math.floor(rx * 1000) / 1000, math.floor(ry * 1000) / 1000, math.floor(rz * 1000) / 1000 },
				c = string.format("%02x%02x%02x",
					math.floor(p.Color.R * 255), math.floor(p.Color.G * 255), math.floor(p.Color.B * 255)),
				t = math.floor(p.Transparency * 100) / 100,
			})
			if #boxes >= MAX_PARTS then break end
		end
	end
end

-- Spawn points give the viewer somewhere to anchor "players come from here".
local spawns = {}
for _, s in ipairs(workspace:GetDescendants()) do
	if s:IsA("SpawnLocation") then
		table.insert(spawns, { name = s.Name, p = { s.Position.X, s.Position.Y, s.Position.Z } })
	end
end

return game:GetService("HttpService"):JSONEncode({
	bounds = { min = { MIN.X, MIN.Y, MIN.Z }, max = { MAX.X, MAX.Y, MAX.Z } },
	boxes = boxes,
	spawns = spawns,
})
`;

// Optional: npx tsx export-geometry.ts "Place1" targets a specific open
// Studio by name when more than one is connected.
const studioFilter = process.argv[2];

const bridge = new StudioBridge();
await bridge.connect();
const result = await bridge.executeLuau(LUAU, "Edit", studioFilter);
await bridge.close();

if (result.isError) {
  console.error(`[geometry] Studio returned an error: ${result.text}`);
  process.exit(1);
}

const geometry = JSON.parse(result.text) as { boxes: unknown[]; spawns: unknown[] };
console.log(`[geometry] ${geometry.boxes.length} boxes, ${geometry.spawns.length} spawn(s)`);

const res = await fetch(`${BASE_URL}/api/geometry`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_TOKEN}` },
  body: JSON.stringify(geometry),
});
console.log(`[geometry] backend replied ${res.status}: ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
