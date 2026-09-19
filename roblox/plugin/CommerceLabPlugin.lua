--[[
	Fallback 2 from the build spec: apply a change plan with no Bridge and no
	MCP in the loop. One button in Studio, and it works even if the stdio MCP
	connection is dead.

	Install: copy this file into %LOCALAPPDATA%\Roblox\Plugins\ and restart
	Studio. It appears as a "Commerce Lab" toolbar tab.

	Two ways in, so it degrades further if the backend is also down:
	  FETCH + APPLY  - pulls the queued plan from the backend over HTTP.
	  APPLY PASTED   - reads ServerStorage.PendingPlan (a StringValue you paste
	                   JSON into), so it needs no network at all.
	  ROLL BACK      - restores the snapshot this plugin took before applying.
--]]

local HttpService = game:GetService("HttpService")
local ServerStorage = game:GetService("ServerStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local SNAPSHOT_NAME = "CommerceLabLastSnapshot"

local toolbar = plugin:CreateToolbar("Commerce Lab")
local fetchButton = toolbar:CreateButton("Fetch + Apply", "Pull the queued plan from the backend and apply it", "")
local pasteButton = toolbar:CreateButton("Apply Pasted", "Apply ServerStorage.PendingPlan without any network", "")
local rollbackButton = toolbar:CreateButton("Roll Back", "Restore the snapshot taken before the last apply", "")

local function api()
	local storefront = ServerScriptService:FindFirstChild("Storefront")
	local module = storefront and storefront:FindFirstChild("StorefrontAPI")
	if not module then
		warn("[commerce-lab] ServerScriptService.Storefront.StorefrontAPI is missing")
		return nil
	end
	local ok, result = pcall(require, module)
	if not ok then
		warn("[commerce-lab] could not load StorefrontAPI:", result)
		return nil
	end
	return result
end

local function config()
	local storefront = ServerScriptService:FindFirstChild("Storefront")
	local module = storefront and storefront:FindFirstChild("Config")
	if not module then return nil end
	local ok, result = pcall(require, module)
	return ok and result or nil
end

-- Snapshot before every apply, so this path is reversible too.
local function snapshotFirst(StorefrontAPI)
	local snapshot = StorefrontAPI.snapshot()
	local holder = ServerStorage:FindFirstChild(SNAPSHOT_NAME)
	if not holder then
		holder = Instance.new("StringValue")
		holder.Name = SNAPSHOT_NAME
		holder.Parent = ServerStorage
	end
	holder.Value = snapshot
	print(string.format("[commerce-lab] snapshot stored (%d bytes)", #snapshot))
end

local function applyPlan(planJson: string)
	local StorefrontAPI = api()
	if not StorefrontAPI then return end

	snapshotFirst(StorefrontAPI)

	local resultJson = StorefrontAPI.apply(planJson)
	local ok, decoded = pcall(function() return HttpService:JSONDecode(resultJson) end)
	if not ok then
		warn("[commerce-lab] apply returned something unreadable:", resultJson)
		return
	end

	print(string.format(
		"[commerce-lab] applied %d op(s), rejected %d",
		#(decoded.applied or {}), #(decoded.rejected or {})
	))
	for _, rejection in ipairs(decoded.rejected or {}) do
		warn(string.format("[commerce-lab]   rejected %s: %s", tostring(rejection.op), tostring(rejection.reason)))
	end
end

fetchButton.Click:Connect(function()
	local cfg = config()
	if not cfg then
		warn("[commerce-lab] no Config module — run bridge/sync-config.ts first")
		return
	end

	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = cfg.BASE_URL .. "/api/bridge/next",
			Method = "GET",
			Headers = { ["Authorization"] = "Bearer " .. cfg.AUTH_TOKEN },
		})
	end)
	if not ok then
		warn("[commerce-lab] backend unreachable:", response)
		return
	end
	if not response.Success then
		warn(string.format("[commerce-lab] backend replied %d: %s", response.StatusCode, tostring(response.Body)))
		return
	end

	local body = HttpService:JSONDecode(response.Body)
	if not body.pending then
		print("[commerce-lab] nothing queued — press APPLY TO ROBLOX in the dashboard first")
		return
	end
	if body.action == "restore" and body.snapshot then
		local StorefrontAPI = api()
		if StorefrontAPI then print("[commerce-lab] restoring:", StorefrontAPI.restore(body.snapshot)) end
		return
	end

	print("[commerce-lab] applying " .. tostring(body.experimentId))
	applyPlan(HttpService:JSONEncode(body.plan))
end)

pasteButton.Click:Connect(function()
	local holder = ServerStorage:FindFirstChild("PendingPlan")
	if not holder or not holder:IsA("StringValue") or holder.Value == "" then
		warn('[commerce-lab] create a StringValue named "PendingPlan" in ServerStorage and paste the plan JSON into its Value')
		return
	end
	applyPlan(holder.Value)
end)

rollbackButton.Click:Connect(function()
	local StorefrontAPI = api()
	if not StorefrontAPI then return end
	local holder = ServerStorage:FindFirstChild(SNAPSHOT_NAME)
	if not holder or holder.Value == "" then
		warn("[commerce-lab] no snapshot stored yet — this plugin takes one on every apply")
		return
	end
	print("[commerce-lab] restoring:", StorefrontAPI.restore(holder.Value))
end)

print("[commerce-lab] plugin loaded")
