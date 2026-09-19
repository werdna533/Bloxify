--!strict
-- The only surface MCP ever calls. The AI never writes Luau; it emits a plan
-- of named operations and this module decides whether each one is legal.

local CollectionService = game:GetService("CollectionService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local HttpService = game:GetService("HttpService")

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

-- ------------------------------------------------------------------- reading

function StorefrontAPI.registry(): string
	local slots, components = {}, {}

	for _, s in ipairs(CollectionService:GetTagged("StorefrontSlot")) do
		local facing = s:GetAttribute("facing") or Vector3.new(0, 0, 1)
		table.insert(slots, {
			slotId = s:GetAttribute("slotId"),
			trafficRank = s:GetAttribute("trafficRank"),
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
	local recording = ChangeHistoryService:TryBeginRecording("Storefront restore")

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
	if recording then ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end

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
	local recording = ChangeHistoryService:TryBeginRecording("Storefront apply")

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
	if recording then ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end

	return HttpService:JSONEncode({
		ok = #rejected == 0,
		applied = applied,
		rejected = rejected,
		errors = errors,
		experimentId = workspace:GetAttribute("ExperimentId"),
	})
end

return StorefrontAPI
