--!strict
-- Ports bridge/export-geometry.ts's Luau payload into the live server itself.
-- The geometry walk never actually needed Studio -- it only ran through MCP
-- because it started life as a dev-time CLI script. A running server has the
-- exact same workspace/HttpService access, so it can capture and push its own
-- room shell on startup, the same way Telemetry.lua reports events, instead
-- of requiring someone to keep an MCP session open just to re-run it.

local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local Config = require(game:GetService("ServerScriptService").Storefront.Config)

local MAX_PARTS = 500
local SKIP_ANCESTORS = { "Storefront", "Forcefields" }

local function skipped(part: Instance): boolean
	for _, name in ipairs(SKIP_ANCESTORS) do
		if part:FindFirstAncestor(name) then return true end
	end
	return false
end

local function captureGeometry(): string?
	local region = CollectionService:GetTagged("StorefrontRegion")[1]
	if not region or not region:IsA("BasePart") then
		warn("[geometry-export] no Part tagged StorefrontRegion in this place -- skipping")
		return nil
	end

	local half = region.Size / 2
	local MIN = region.Position - Vector3.new(half.X + 20, 20, half.Z + 20)
	local MAX = region.Position + Vector3.new(half.X + 20, 30, half.Z + 20)

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

	local spawns = {}
	for _, s in ipairs(workspace:GetDescendants()) do
		if s:IsA("SpawnLocation") then
			table.insert(spawns, { name = s.Name, p = { s.Position.X, s.Position.Y, s.Position.Z } })
		end
	end

	return HttpService:JSONEncode({
		bounds = { min = { MIN.X, MIN.Y, MIN.Z }, max = { MAX.X, MAX.Y, MAX.Z } },
		boxes = boxes,
		spawns = spawns,
	})
end

local function exportOnce()
	local payload = captureGeometry()
	if not payload then return end

	local ok, err = pcall(function()
		local res = HttpService:RequestAsync({
			Url = Config.BASE_URL .. "/api/geometry",
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
				["Authorization"] = "Bearer " .. Config.AUTH_TOKEN,
			},
			Body = payload,
		})
		if not res.Success then
			warn(string.format("[geometry-export] backend replied %d: %s", res.StatusCode, tostring(res.Body)))
		else
			print("[geometry-export] room shell synced")
		end
	end)
	if not ok then
		warn("[geometry-export] request failed: " .. tostring(err))
	end
end

-- A short delay lets any decor/streaming still settling in on server start
-- finish before the walk, rather than capturing a half-loaded room.
task.spawn(function()
	task.wait(10)
	exportOnce()
end)
