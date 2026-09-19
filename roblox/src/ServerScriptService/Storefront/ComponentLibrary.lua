--!strict
-- Builds storefront display models from primitives.
-- Placeholder geometry: the garment parts are flat colours standing in for
-- product imagery until real textures are generated.

local CollectionService = game:GetService("CollectionService")

local ComponentLibrary = {}

ComponentLibrary.KINDS = { "Mannequin", "PlushStand", "ProductStand", "ProductWall" }

local SHELL = Color3.fromRGB(198, 193, 184)
local PEDESTAL = Color3.fromRGB(58, 58, 64)
local SIGN_FACE = Color3.fromRGB(28, 28, 32)

local function part(name: string, size: Vector3, offset: Vector3, colour: Color3, shape: string?): Part
	local p = Instance.new("Part")
	p.Name = name
	p.Size = size
	p.Anchored = true
	p.CanCollide = false
	p.Color = colour
	p.Material = Enum.Material.SmoothPlastic
	if shape == "Ball" then
		p.Shape = Enum.PartType.Ball
	elseif shape == "Cylinder" then
		p.Shape = Enum.PartType.Cylinder
		-- Roblox cylinders extend along X; stand it upright.
		p.CFrame = CFrame.new(offset) * CFrame.Angles(0, 0, math.rad(90))
		return p
	end
	p.CFrame = CFrame.new(offset)
	return p
end

local function addSign(model: Model, height: number)
	local sign = part("Sign", Vector3.new(5.2, 1.7, 0.2), Vector3.new(0, height, 0), SIGN_FACE)
	sign.Parent = model

	local gui = Instance.new("SurfaceGui")
	gui.Name = "SignGui"
	gui.Face = Enum.NormalId.Front
	gui.CanvasSize = Vector2.new(520, 170)
	gui.Parent = sign

	local header = Instance.new("TextLabel")
	header.Name = "HeaderLabel"
	header.Size = UDim2.fromScale(1, 0.55)
	header.Position = UDim2.fromScale(0, 0.04)
	header.BackgroundTransparency = 1
	header.Font = Enum.Font.GothamBold
	header.TextScaled = true
	header.TextColor3 = Color3.fromRGB(245, 245, 245)
	header.Text = ""
	header.Parent = gui

	local cta = Instance.new("TextLabel")
	cta.Name = "CtaLabel"
	cta.Size = UDim2.fromScale(1, 0.34)
	cta.Position = UDim2.fromScale(0, 0.62)
	cta.BackgroundTransparency = 1
	cta.Font = Enum.Font.Gotham
	cta.TextScaled = true
	cta.TextColor3 = Color3.fromRGB(150, 220, 190)
	cta.Text = ""
	cta.Parent = gui
end

local function addBillboard(model: Model, anchor: BasePart, height: number)
	local host = part("BillboardAnchor", Vector3.new(0.2, 0.2, 0.2), Vector3.new(0, height, 0), SHELL)
	host.Transparency = 1
	host.Parent = model

	local bb = Instance.new("BillboardGui")
	bb.Name = "InfoBillboard"
	bb.Size = UDim2.fromScale(7, 2.4)
	bb.StudsOffsetWorldSpace = Vector3.new(0, 0, 0)
	bb.AlwaysOnTop = false
	bb.MaxDistance = 60
	bb.Parent = host

	local title = Instance.new("TextLabel")
	title.Name = "TitleLabel"
	title.Size = UDim2.fromScale(1, 0.6)
	title.BackgroundTransparency = 1
	title.Font = Enum.Font.GothamBold
	title.TextScaled = true
	title.TextColor3 = Color3.fromRGB(255, 255, 255)
	title.TextStrokeTransparency = 0.4
	title.Text = ""
	title.Parent = bb

	local price = Instance.new("TextLabel")
	price.Name = "PriceLabel"
	price.Size = UDim2.fromScale(1, 0.4)
	price.Position = UDim2.fromScale(0, 0.6)
	price.BackgroundTransparency = 1
	price.Font = Enum.Font.Gotham
	price.TextScaled = true
	price.TextColor3 = Color3.fromRGB(190, 230, 255)
	price.TextStrokeTransparency = 0.5
	price.Text = ""
	price.Parent = bb
end

local function buildMannequin(garmentColour: Color3, garmentOnLegs: boolean): (Model, BasePart)
	local model = Instance.new("Model")

	local root = part("Root", Vector3.new(4.2, 0.6, 4.2), Vector3.new(0, 0.3, 0), PEDESTAL, "Cylinder")
	root.CanCollide = true
	root.Parent = model

	part("Legs", Vector3.new(1.7, 3.0, 1.1), Vector3.new(0, 2.1, 0), SHELL).Parent = model
	part("Torso", Vector3.new(2.2, 2.6, 1.2), Vector3.new(0, 4.9, 0), SHELL).Parent = model
	part("Head", Vector3.new(1.4, 1.4, 1.4), Vector3.new(0, 6.9, 0), SHELL, "Ball").Parent = model
	part("ArmLeft", Vector3.new(0.6, 2.4, 0.6), Vector3.new(-1.35, 4.7, 0), SHELL).Parent = model
	part("ArmRight", Vector3.new(0.6, 2.4, 0.6), Vector3.new(1.35, 4.7, 0), SHELL).Parent = model

	if garmentOnLegs then
		part("Garment", Vector3.new(2.0, 3.2, 1.4), Vector3.new(0, 2.1, 0), garmentColour).Parent = model
	else
		part("Garment", Vector3.new(2.5, 2.8, 1.5), Vector3.new(0, 4.9, 0), garmentColour).Parent = model
		part("GarmentSleeveL", Vector3.new(0.8, 1.6, 0.8), Vector3.new(-1.35, 5.1, 0), garmentColour).Parent = model
		part("GarmentSleeveR", Vector3.new(0.8, 1.6, 0.8), Vector3.new(1.35, 5.1, 0), garmentColour).Parent = model
	end

	addSign(model, 9.0)
	addBillboard(model, root, 10.6)
	return model, root
end

local function buildPlushStand(bodyColour: Color3): (Model, BasePart)
	local model = Instance.new("Model")

	local root = part("Root", Vector3.new(3.6, 2.4, 3.6), Vector3.new(0, 1.2, 0), PEDESTAL, "Cylinder")
	root.CanCollide = true
	root.Parent = model

	-- Front of a part is its -Z face, and models are pivoted so -Z faces the
	-- aisle, so the goose has to look down -Z or it faces the wall.
	part("Body", Vector3.new(2.4, 2.0, 3.0), Vector3.new(0, 3.4, 0), bodyColour, "Ball").Parent = model
	part("Neck", Vector3.new(0.75, 2.0, 0.75), Vector3.new(0, 4.7, -0.5), bodyColour).Parent = model
	part("Head", Vector3.new(1.1, 1.1, 1.1), Vector3.new(0, 5.7, -0.8), bodyColour, "Ball").Parent = model
	part("Beak", Vector3.new(0.42, 0.34, 0.8), Vector3.new(0, 5.6, -1.5), Color3.fromRGB(240, 150, 40)).Parent = model

	addSign(model, 7.6)
	addBillboard(model, root, 9.0)
	return model, root
end

--[[
	spec = {
		componentId, productId, title, price,
		kind, garmentColour, garmentOnLegs,
		ctaText, signageText,
	}
]]
function ComponentLibrary.build(spec: { [string]: any }): Model
	local model: Model, root: BasePart
	if spec.kind == "PlushStand" then
		model, root = buildPlushStand(spec.garmentColour or Color3.fromRGB(245, 245, 245))
	else
		model, root = buildMannequin(spec.garmentColour or SHELL, spec.garmentOnLegs == true)
	end

	model.Name = spec.componentId
	model.PrimaryPart = root

	-- This place has StreamingEnabled, so by default a display more than a few
	-- hundred studs away would not exist on the client at all — and the client
	-- is what computes impressions and gaze. A display we cannot see from
	-- across the room would silently record nothing, which is exactly the
	-- measurement this project exists to make. Persistent keeps all five on
	-- every client for the whole session.
	model.ModelStreamingMode = Enum.ModelStreamingMode.Persistent

	local prompt = Instance.new("ProximityPrompt")
	prompt.Name = "InspectPrompt"
	prompt.ActionText = spec.ctaText or "View"
	prompt.ObjectText = spec.title or spec.componentId
	prompt.HoldDuration = 0.4
	prompt.MaxActivationDistance = 12
	prompt.RequiresLineOfSight = false
	prompt.Parent = root

	model:SetAttribute("componentId", spec.componentId)
	model:SetAttribute("productId", spec.productId)
	model:SetAttribute("title", spec.title)
	model:SetAttribute("price", spec.price)
	model:SetAttribute("kind", spec.kind)
	model:SetAttribute("prominence", 1)
	model:SetAttribute("interactionEnabled", true)
	model:SetAttribute("ctaText", spec.ctaText or "View")
	model:SetAttribute("signageText", spec.signageText or spec.title or "")
	model:SetAttribute("garmentColour", spec.garmentColour or SHELL)
	model:SetAttribute("garmentOnLegs", spec.garmentOnLegs == true)

	ComponentLibrary.refreshText(model)
	CollectionService:AddTag(model, "StorefrontComponent")
	return model
end

-- Keeps the sign and billboard in step with the model's attributes.
function ComponentLibrary.refreshText(model: Model)
	local sign = model:FindFirstChild("Sign")
	if sign then
		local gui = sign:FindFirstChild("SignGui")
		if gui then
			local header = gui:FindFirstChild("HeaderLabel")
			local cta = gui:FindFirstChild("CtaLabel")
			if header and header:IsA("TextLabel") then
				header.Text = model:GetAttribute("signageText") or ""
			end
			if cta and cta:IsA("TextLabel") then
				cta.Text = model:GetAttribute("ctaText") or ""
			end
		end
	end

	local anchor = model:FindFirstChild("BillboardAnchor")
	if anchor then
		local bb = anchor:FindFirstChild("InfoBillboard")
		if bb then
			local title = bb:FindFirstChild("TitleLabel")
			local price = bb:FindFirstChild("PriceLabel")
			if title and title:IsA("TextLabel") then
				title.Text = model:GetAttribute("title") or model.Name
			end
			if price and price:IsA("TextLabel") then
				local value = model:GetAttribute("price")
				price.Text = value and string.format("$%.2f", value) or ""
			end
		end
	end

	local root = model.PrimaryPart
	if root then
		local prompt = root:FindFirstChild("InspectPrompt")
		if prompt and prompt:IsA("ProximityPrompt") then
			prompt.ActionText = model:GetAttribute("ctaText") or "View"
			prompt.ObjectText = model:GetAttribute("title") or model.Name
			prompt.Enabled = model:GetAttribute("interactionEnabled") ~= false
		end
	end
end

return ComponentLibrary
