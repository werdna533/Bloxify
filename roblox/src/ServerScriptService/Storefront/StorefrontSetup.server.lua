--!strict
-- Polls the backend for a pending "build the storefront" job and executes it
-- with plain Luau -- no MCP, no Studio session. This is what makes
-- "Create Storefront" work for someone else's Roblox place: the Cloudflare
-- Worker reasons about the catalog and layout, this script just builds
-- whatever it's told, using the same ComponentLibrary/StorefrontAPI code
-- path the AI's own move_to_position already goes through.

local HttpService = game:GetService("HttpService")

local Config = require(game:GetService("ServerScriptService").Storefront.Config)
local ComponentLibrary = require(script.Parent.ComponentLibrary)
local StorefrontAPI = require(script.Parent.StorefrontAPI)

local POLL_SECONDS = 5

type JobItem = {
	componentId: string,
	productId: string,
	title: string,
	price: number,
	imageUrl: string?,
	kind: string,
	garmentOnLegs: boolean,
	x: number,
	z: number,
	facingDegrees: number,
	-- Only present if the Next.js backend had a Roblox Open Cloud key
	-- configured; otherwise these come through as nil and the component
	-- gets the ComponentLibrary default look until set manually.
	imageAssetId: string?,
	shirtTemplateId: string?,
	pantsTemplateId: string?,
}

-- Builds one component from a job item and places it through the same
-- validated move_to_position path the AI uses, so a bad layout from the
-- Worker's coarse pre-check still can't land inside a wall here.
local function buildItem(item: JobItem): (boolean, string?)
	local model = ComponentLibrary.build({
		componentId = item.componentId,
		productId = item.productId,
		title = item.title,
		price = item.price,
		kind = item.kind,
		garmentOnLegs = item.garmentOnLegs,
		imageAssetId = item.imageAssetId,
		shirtTemplateId = item.shirtTemplateId,
		pantsTemplateId = item.pantsTemplateId,
	})
	model.Parent = workspace

	local plan = HttpService:JSONEncode({
		ops = {
			{
				op = "move_to_position",
				componentId = item.componentId,
				x = item.x,
				z = item.z,
				facingDegrees = item.facingDegrees,
			},
		},
	})
	local resultJson = StorefrontAPI.apply(plan)
	local ok, result = pcall(function()
		return HttpService:JSONDecode(resultJson)
	end)
	if not ok or not result.ok then
		model:Destroy()
		local reason = (ok and result.rejected and result.rejected[1] and result.rejected[1].reason) or "placement failed"
		return false, string.format("%s: %s", item.componentId, tostring(reason))
	end
	return true
end

local function pollOnce()
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = Config.BASE_URL .. "/api/storefront/pending",
			Method = "GET",
			Headers = { ["Authorization"] = "Bearer " .. Config.AUTH_TOKEN },
		})
	end)
	if not ok or not response.Success then return end

	local decoded = nil
	local decodeOk = pcall(function()
		decoded = HttpService:JSONDecode(response.Body)
	end)
	if not decodeOk or not decoded or decoded.pending ~= true then return end

	local job = decoded.job :: { JobItem }
	local failures = {}
	for _, item in ipairs(job) do
		local itemOk, why = buildItem(item)
		if not itemOk then
			table.insert(failures, why)
		end
	end

	local buildOk = #failures == 0
	workspace:SetAttribute("HasStorefront", buildOk)

	pcall(function()
		HttpService:RequestAsync({
			Url = Config.BASE_URL .. "/api/storefront/report",
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
				["Authorization"] = "Bearer " .. Config.AUTH_TOKEN,
			},
			Body = HttpService:JSONEncode({
				ok = buildOk,
				error = buildOk and nil or table.concat(failures, "; "),
			}),
		})
	end)
end

task.spawn(function()
	while true do
		task.wait(POLL_SECONDS)
		-- A place that already has a storefront has nothing to poll for; this
		-- also stops a completed build from being re-triggered by a stray job.
		if workspace:GetAttribute("HasStorefront") ~= true then
			pollOnce()
		end
	end
end)

print("[storefront-setup] polling for a pending layout")
