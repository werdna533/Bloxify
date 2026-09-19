--!strict
-- The only surface MCP ever calls. The AI never writes Luau; it emits a plan
-- of named operations and this module decides whether each one is legal.

local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

-- Undo recording is a Studio-only facility. This module is only ever driven
-- from Edit mode, but it lives in ServerScriptService and would be loadable on
-- a live server, so guard it rather than letting a require blow up there.
local ChangeHistoryService = RunService:IsStudio() and game:GetService("ChangeHistoryService") or nil

local function beginRecording(name: string): any
	if not ChangeHistoryService then return nil end
	local ok, recording = pcall(function()
		return ChangeHistoryService:TryBeginRecording(name)
	end)
	return ok and recording or nil
end

local function finishRecording(recording: any)
	if not ChangeHistoryService or not recording then return end
	pcall(function()
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end)
end

local ComponentLibrary = require(script.Parent.ComponentLibrary)

local StorefrontAPI = {}

local MAX_OPS = 5
local MAX_CTA = 40
local MAX_SIGNAGE = 60
local PROMINENCE_SCALE = { [1] = 1.0, [2] = 1.25, [3] = 1.5 }
local ACCENT = {
	[1] = Color3.fromRGB(58, 58, 64),
	[2] = Color3.fromRGB(70, 92, 120),
	[3] = Color3.fromRGB(150, 120, 40),
}

-- Anything a player could read on screen goes through this.
local BANNED = { "http://", "https://", "www.", "<", ">", "\n", "\r" }

local function findComponent(componentId: string): Model?
	for _, m in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
		if m:GetAttribute("componentId") == componentId and m:IsA("Model") then
			return m
		end
	end
	return nil
end

local function findSlot(slotId: string): BasePart?
	for _, s in ipairs(CollectionService:GetTagged("StorefrontSlot")) do
		if s:GetAttribute("slotId") == slotId and s:IsA("BasePart") then
			return s
		end
	end
	return nil
end

local function placeAtSlot(model: Model, slot: BasePart)
	local facing = slot:GetAttribute("facing") or Vector3.new(0, 0, 1)
	local base = slot.Position + Vector3.new(0, -0.1, 0)
	model:PivotTo(CFrame.lookAt(base, base + facing))
	model:SetAttribute("slotId", slot:GetAttribute("slotId"))
end

local function textIsSafe(text: string): (boolean, string?)
	local lowered = string.lower(text)
	for _, bad in ipairs(BANNED) do
		if string.find(lowered, bad, 1, true) then
			return false, string.format("text contains %q", bad)
		end
	end
	return true
end

-- ---------------------------------------------------------------- operations

local ops = {}

function ops.move_to_slot(op: { [string]: any }): (boolean, string?)
	local model = findComponent(op.componentId)
	if not model then return false, "unknown componentId " .. tostring(op.componentId) end
	local slot = findSlot(op.slotId)
	if not slot then return false, "unknown slotId " .. tostring(op.slotId) end

	local currentSlotId = model:GetAttribute("slotId")
	if currentSlotId == op.slotId then return true end

	-- If something already stands there, swap the two rather than overlap.
	for _, other in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
		if other ~= model and other:GetAttribute("slotId") == op.slotId and other:IsA("Model") then
			local oldSlot = currentSlotId and findSlot(currentSlotId)
			if oldSlot then placeAtSlot(other, oldSlot) end
			break
		end
	end

	placeAtSlot(model, slot)
	return true
end

function ops.set_prominence(op: { [string]: any }): (boolean, string?)
	local model = findComponent(op.componentId)
	if not model then return false, "unknown componentId " .. tostring(op.componentId) end
	local level = tonumber(op.level)
	if not level or not PROMINENCE_SCALE[level] then return false, "prominence must be 1, 2 or 3" end

	model:ScaleTo(PROMINENCE_SCALE[level])
	model:SetAttribute("prominence", level)

	local root = model.PrimaryPart
	if root then
		root.Color = ACCENT[level]
		local light = root:FindFirstChild("ProminenceLight")
		if level > 1 then
			if not light then
				local spot = Instance.new("SpotLight")
				spot.Name = "ProminenceLight"
				spot.Face = Enum.NormalId.Top
				spot.Angle = 70
				spot.Parent = root
			end
			local spot = root:FindFirstChild("ProminenceLight") :: SpotLight
			spot.Brightness = level == 3 and 3 or 1.6
			spot.Range = level == 3 and 24 or 16
		elseif light then
			light:Destroy()
		end
	end
	return true
end

function ops.enable_interaction(op: { [string]: any }): (boolean, string?)
	local model = findComponent(op.componentId)
	if not model then return false, "unknown componentId " .. tostring(op.componentId) end
	model:SetAttribute("interactionEnabled", true)
	ComponentLibrary.refreshText(model)
	return true
end

function ops.disable_interaction(op: { [string]: any }): (boolean, string?)
	local model = findComponent(op.componentId)
	if not model then return false, "unknown componentId " .. tostring(op.componentId) end
	model:SetAttribute("interactionEnabled", false)
	ComponentLibrary.refreshText(model)
	return true
end

function ops.set_cta_text(op: { [string]: any }): (boolean, string?)
	local model = findComponent(op.componentId)
	if not model then return false, "unknown componentId " .. tostring(op.componentId) end
	local text = tostring(op.text or "")
	if #text == 0 then return false, "cta text is empty" end
	if #text > MAX_CTA then return false, string.format("cta text is %d chars, cap is %d", #text, MAX_CTA) end
	local safe, why = textIsSafe(text)
	if not safe then return false, why end

	model:SetAttribute("ctaText", text)
	ComponentLibrary.refreshText(model)
	return true
end

function ops.set_signage(op: { [string]: any }): (boolean, string?)
	local model = findComponent(op.componentId)
	if not model then return false, "unknown componentId " .. tostring(op.componentId) end
	local text = tostring(op.text or "")
	if #text == 0 then return false, "signage text is empty" end
	if #text > MAX_SIGNAGE then return false, string.format("signage is %d chars, cap is %d", #text, MAX_SIGNAGE) end
	local safe, why = textIsSafe(text)
	if not safe then return false, why end

	model:SetAttribute("signageText", text)
	ComponentLibrary.refreshText(model)
	return true
end

function ops.set_kind(op: { [string]: any }): (boolean, string?)
	local model = findComponent(op.componentId)
	if not model then return false, "unknown componentId " .. tostring(op.componentId) end

	local kind = tostring(op.kind)
	local known = false
	for _, k in ipairs(ComponentLibrary.KINDS) do
		if k == kind then known = true break end
	end
	if not known then return false, "unknown kind " .. kind end
	if model:GetAttribute("kind") == kind then return true end

	local slotId = model:GetAttribute("slotId")
	local rebuilt = ComponentLibrary.build({
		componentId = model:GetAttribute("componentId"),
		productId = model:GetAttribute("productId"),
		title = model:GetAttribute("title"),
		price = model:GetAttribute("price"),
		kind = kind,
		garmentColour = model:GetAttribute("garmentColour"),
		garmentOnLegs = model:GetAttribute("garmentOnLegs"),
		ctaText = model:GetAttribute("ctaText"),
		signageText = model:GetAttribute("signageText"),
	})
	local prominence = model:GetAttribute("prominence") or 1
	local interaction = model:GetAttribute("interactionEnabled")
	local parent = model.Parent
	model:Destroy()

	rebuilt.Parent = parent
	rebuilt:SetAttribute("slotId", slotId)
	rebuilt:SetAttribute("interactionEnabled", interaction)
	local slot = slotId and findSlot(slotId)
	if slot then placeAtSlot(rebuilt, slot) end
	if prominence ~= 1 then
		ops.set_prominence({ componentId = rebuilt:GetAttribute("componentId"), level = prominence })
	end
	ComponentLibrary.refreshText(rebuilt)
	return true
end

function ops.swap_products(op: { [string]: any }): (boolean, string?)
	local a = findComponent(op.componentIdA)
	local b = findComponent(op.componentIdB)
	if not a then return false, "unknown componentId " .. tostring(op.componentIdA) end
	if not b then return false, "unknown componentId " .. tostring(op.componentIdB) end

	local keys = { "productId", "title", "price", "garmentColour", "garmentOnLegs", "signageText" }
	for _, key in ipairs(keys) do
		local av, bv = a:GetAttribute(key), b:GetAttribute(key)
		a:SetAttribute(key, bv)
		b:SetAttribute(key, av)
	end
	ComponentLibrary.refreshText(a)
	ComponentLibrary.refreshText(b)
	return true
end

-- ---------------------------------------------------------------- sightlines

--[[
	How visible a slot actually is, as opposed to how close it is.

	trafficRank is derived from walking distance to the spawn, which says
	nothing about whether a display can be seen from the floor around it. In
	this place Slot_B is the closest slot to spawn and is also hidden behind a
	doorframe, so the two measures disagree — and a product can be starved of
	impressions by scenery rather than by placement.

	Sampled by raycasting to the slot from a fan of points in front of it.
]]
local SIGHT_RADII = { 8, 14, 20, 28 }
local SIGHT_SPREAD = 80 -- degrees either side of the slot's facing

function StorefrontAPI.computeSightlines(): string
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude

	local ignore = {}
	for _, m in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
		table.insert(ignore, m)
	end
	for _, s in ipairs(CollectionService:GetTagged("StorefrontSlot")) do
		table.insert(ignore, s)
	end
	local forcefields = workspace:FindFirstChild("Forcefields")
	if forcefields then table.insert(ignore, forcefields) end
	params.FilterDescendantsInstances = ignore

	local results = {}
	for _, slot in ipairs(CollectionService:GetTagged("StorefrontSlot")) do
		local target = slot.Position + Vector3.new(0, 4, 0)
		local facing = slot:GetAttribute("facing") or Vector3.new(0, 0, 1)
		local baseAngle = math.atan2(facing.Z, facing.X)

		local visible, total = 0, 0
		for _, radius in ipairs(SIGHT_RADII) do
			for deg = -SIGHT_SPREAD, SIGHT_SPREAD, 20 do
				local angle = baseAngle + math.rad(deg)
				local from = Vector3.new(
					slot.Position.X + math.cos(angle) * radius,
					slot.Position.Y + 3,
					slot.Position.Z + math.sin(angle) * radius
				)
				-- Only count vantage points that are themselves standable.
				local ground = workspace:Raycast(from + Vector3.new(0, 6, 0), Vector3.new(0, -14, 0), params)
				if ground then
					total += 1
					if not workspace:Raycast(from, target - from, params) then
						visible += 1
					end
				end
			end
		end

		local score = total > 0 and (visible / total) or 0
		slot:SetAttribute("visibilityScore", math.floor(score * 1000) / 1000)
		slot:SetAttribute("visibilitySamples", total)
		results[slot:GetAttribute("slotId")] = {
			score = math.floor(score * 1000) / 1000,
			visible = visible,
			samples = total,
			trafficRank = slot:GetAttribute("trafficRank"),
		}
	end

	return HttpService:JSONEncode(results)
end

--[[
	Finds a camera position with a clear view of a target.

	The storefront sits among doorframes, wall trim and foliage, so a fixed
	camera offset lands inside scenery about as often as not. This searches a
	ring of candidate positions and returns the first one that can actually see
	what it is pointed at, which is what before/after screenshots need.
]]
function StorefrontAPI.findCamera(targetPos: Vector3, ignore: { Instance }): (Vector3?, Vector3)
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	local exclude = {}
	for _, inst in ipairs(ignore) do table.insert(exclude, inst) end
	local forcefields = workspace:FindFirstChild("Forcefields")
	if forcefields then table.insert(exclude, forcefields) end
	params.FilterDescendantsInstances = exclude

	local look = targetPos + Vector3.new(0, 1.5, 0)
	for _, radius in ipairs({ 9, 12, 15, 18, 22 }) do
		for _, height in ipairs({ 3, 5, 7 }) do
			for deg = 0, 350, 15 do
				local rad = math.rad(deg)
				local from = targetPos + Vector3.new(math.cos(rad) * radius, height, math.sin(rad) * radius)
				if not workspace:Raycast(from, look - from, params) then
					return from, look
				end
			end
		end
	end
	return nil, look
end

-- Parks the edit camera on a component so a screenshot can be taken of it.
function StorefrontAPI.frameComponent(componentId: string): string
	local model = findComponent(componentId)
	if not model then
		return HttpService:JSONEncode({ ok = false, error = "unknown componentId " .. tostring(componentId) })
	end

	local target = model:GetPivot().Position
	local from, look = StorefrontAPI.findCamera(target, { model })
	if not from then
		return HttpService:JSONEncode({ ok = false, error = "no unobstructed camera position found" })
	end

	local cam = workspace.CurrentCamera
	cam.CameraType = Enum.CameraType.Fixed
	cam.FieldOfView = 50
	cam.CFrame = CFrame.lookAt(from, look)
	return HttpService:JSONEncode({
		ok = true,
		componentId = componentId,
		from = { from.X, from.Y, from.Z },
		lookAt = { look.X, look.Y, look.Z },
	})
end

-- A wide shot that can see the most displays at once, for the store overview.
function StorefrontAPI.frameStore(): string
	local components = CollectionService:GetTagged("StorefrontComponent")
	if #components == 0 then
		return HttpService:JSONEncode({ ok = false, error = "no components" })
	end

	local sum = Vector3.zero
	for _, m in ipairs(components) do sum += m:GetPivot().Position end
	local centre = sum / #components

	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = components

	-- Counting visible displays alone picks spots jammed against a wall: the
	-- rays to the displays are clear while the frame is filled with masonry.
	-- Openness samples a fan around the view direction and rewards a position
	-- that can actually see into the room.
	local function openness(from: Vector3, look: Vector3): number
		local forward = (look - from).Unit
		local total, samples = 0, 0
		for _, yaw in ipairs({ -25, -12, 0, 12, 25 }) do
			for _, pitch in ipairs({ -8, 0, 8 }) do
				local dir = (CFrame.lookAt(from, look) * CFrame.Angles(math.rad(pitch), math.rad(yaw), 0)).LookVector
				local hit = workspace:Raycast(from, dir * 90, params)
				total += hit and hit.Distance or 90
				samples += 1
			end
		end
		return samples > 0 and (total / samples) or 0
	end

	local best, bestScore, bestSeen = nil, -1, 0
	local bestLookPoint = centre + Vector3.new(0, 2, 0)
	for _, radius in ipairs({ 30, 40, 50, 60 }) do
		for _, height in ipairs({ 10, 14, 18 }) do
			for deg = 0, 350, 20 do
				local rad = math.rad(deg)
				local from = centre + Vector3.new(math.cos(rad) * radius, height, math.sin(rad) * radius)
				local seen = 0
				for _, m in ipairs(components) do
					local to = m:GetPivot().Position + Vector3.new(0, 2, 0)
					if not workspace:Raycast(from, to - from, params) then seen += 1 end
				end
				-- Weight both: a clear view of three displays beats a walled-in
				-- view of four.
				local score = seen * 12 + openness(from, bestLookPoint)
				if score > bestScore then
					best, bestScore, bestSeen = from, score, seen
				end
			end
		end
	end
	local bestLook = bestLookPoint

	local cam = workspace.CurrentCamera
	cam.CameraType = Enum.CameraType.Fixed
	cam.FieldOfView = 60
	cam.CFrame = CFrame.lookAt(best, bestLook)
	return HttpService:JSONEncode({
		ok = true,
		visibleDisplays = bestSeen,
		totalDisplays = #components,
		from = { best.X, best.Y, best.Z },
	})
end

-- ------------------------------------------------------------------- reading

function StorefrontAPI.registry(): string
	local slots, components = {}, {}

	for _, s in ipairs(CollectionService:GetTagged("StorefrontSlot")) do
		local facing = s:GetAttribute("facing") or Vector3.new(0, 0, 1)
		table.insert(slots, {
			slotId = s:GetAttribute("slotId"),
			trafficRank = s:GetAttribute("trafficRank"),
			visibilityScore = s:GetAttribute("visibilityScore"),
			pos = { s.Position.X, s.Position.Y, s.Position.Z },
			facing = { facing.X, facing.Y, facing.Z },
		})
	end
	table.sort(slots, function(a, b) return (a.trafficRank or 99) < (b.trafficRank or 99) end)

	for _, m in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
		local pivot = m:GetPivot()
		table.insert(components, {
			componentId = m:GetAttribute("componentId"),
			productId = m:GetAttribute("productId"),
			title = m:GetAttribute("title"),
			price = m:GetAttribute("price"),
			slotId = m:GetAttribute("slotId"),
			kind = m:GetAttribute("kind"),
			prominence = m:GetAttribute("prominence") or 1,
			interactionEnabled = m:GetAttribute("interactionEnabled") ~= false,
			ctaText = m:GetAttribute("ctaText"),
			signageText = m:GetAttribute("signageText"),
			pos = { pivot.Position.X, pivot.Position.Y, pivot.Position.Z },
			facing = { pivot.LookVector.X, pivot.LookVector.Y, pivot.LookVector.Z },
		})
	end
	table.sort(components, function(a, b) return tostring(a.componentId) < tostring(b.componentId) end)

	return HttpService:JSONEncode({
		slots = slots,
		components = components,
		kinds = ComponentLibrary.KINDS,
		experimentId = workspace:GetAttribute("ExperimentId") or "exp_baseline",
		place = {
			name = game.Name,
			placeId = game.PlaceId,
			gameId = game.GameId,
		},
	})
end

function StorefrontAPI.snapshot(): string
	local state = {}
	for _, m in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
		local colour = m:GetAttribute("garmentColour")
		table.insert(state, {
			componentId = m:GetAttribute("componentId"),
			productId = m:GetAttribute("productId"),
			title = m:GetAttribute("title"),
			price = m:GetAttribute("price"),
			slotId = m:GetAttribute("slotId"),
			kind = m:GetAttribute("kind"),
			prominence = m:GetAttribute("prominence") or 1,
			interactionEnabled = m:GetAttribute("interactionEnabled") ~= false,
			ctaText = m:GetAttribute("ctaText"),
			signageText = m:GetAttribute("signageText"),
			garmentOnLegs = m:GetAttribute("garmentOnLegs") == true,
			garmentColour = colour and { colour.R, colour.G, colour.B } or nil,
		})
	end
	return HttpService:JSONEncode({
		takenAt = os.time(),
		experimentId = workspace:GetAttribute("ExperimentId") or "exp_baseline",
		components = state,
	})
end

function StorefrontAPI.restore(json: string): string
	local ok, decoded = pcall(function() return HttpService:JSONDecode(json) end)
	if not ok then
		return HttpService:JSONEncode({ ok = false, errors = { "snapshot is not valid JSON" } })
	end

	local restored, errors = {}, {}
	local recording = beginRecording("Storefront restore")

	for _, entry in ipairs(decoded.components or {}) do
		local model = findComponent(entry.componentId)
		if not model then
			table.insert(errors, "missing component " .. tostring(entry.componentId))
		else
			if entry.kind and model:GetAttribute("kind") ~= entry.kind then
				ops.set_kind({ componentId = entry.componentId, kind = entry.kind })
				model = findComponent(entry.componentId) :: Model
			end
			model:SetAttribute("productId", entry.productId)
			model:SetAttribute("title", entry.title)
			model:SetAttribute("price", entry.price)
			model:SetAttribute("ctaText", entry.ctaText)
			model:SetAttribute("signageText", entry.signageText)
			model:SetAttribute("interactionEnabled", entry.interactionEnabled ~= false)
			model:SetAttribute("garmentOnLegs", entry.garmentOnLegs == true)
			if entry.garmentColour then
				model:SetAttribute("garmentColour",
					Color3.new(entry.garmentColour[1], entry.garmentColour[2], entry.garmentColour[3]))
			end
			ops.set_prominence({ componentId = entry.componentId, level = entry.prominence or 1 })
			local slot = entry.slotId and findSlot(entry.slotId)
			if slot then placeAtSlot(model, slot) end
			ComponentLibrary.refreshText(model)
			table.insert(restored, entry.componentId)
		end
	end

	if decoded.experimentId then
		workspace:SetAttribute("ExperimentId", decoded.experimentId)
	end
	finishRecording(recording)

	return HttpService:JSONEncode({ ok = #errors == 0, restored = restored, errors = errors })
end

-- ------------------------------------------------------------------- writing

function StorefrontAPI.apply(planJson: string): string
	local ok, plan = pcall(function() return HttpService:JSONDecode(planJson) end)
	if not ok then
		return HttpService:JSONEncode({ ok = false, applied = {}, rejected = {}, errors = { "plan is not valid JSON" } })
	end

	local list = plan.ops or {}
	if #list == 0 then
		return HttpService:JSONEncode({ ok = false, applied = {}, rejected = {}, errors = { "plan contains no ops" } })
	end
	if #list > MAX_OPS then
		return HttpService:JSONEncode({
			ok = false, applied = {}, rejected = {},
			errors = { string.format("plan has %d ops, cap is %d", #list, MAX_OPS) },
		})
	end

	local applied, rejected, errors = {}, {}, {}
	local recording = beginRecording("Storefront apply")

	for index, op in ipairs(list) do
		local handler = ops[tostring(op.op)]
		if not handler then
			table.insert(rejected, { index = index, op = op.op, reason = "unsupported operation" })
		else
			-- One bad op must not abort the rest of the plan.
			local success, result, why = pcall(handler, op)
			if not success then
				table.insert(rejected, { index = index, op = op.op, reason = "error: " .. tostring(result) })
				table.insert(errors, tostring(result))
			elseif result then
				table.insert(applied, op.op)
			else
				table.insert(rejected, { index = index, op = op.op, reason = why or "rejected" })
			end
		end
	end

	if plan.experimentId then
		workspace:SetAttribute("ExperimentId", plan.experimentId)
	end
	finishRecording(recording)

	return HttpService:JSONEncode({
		ok = #rejected == 0,
		applied = applied,
		rejected = rejected,
		errors = errors,
		experimentId = workspace:GetAttribute("ExperimentId"),
	})
end

return StorefrontAPI
