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

--[[
	An axis-aligned anchor used as the PrimaryPart.

	The pedestal is a cylinder, and Roblox cylinders extend along X, so drawing
	one upright means baking a 90 degree roll into its CFrame. Making that the
	PrimaryPart puts the roll into the model's pivot, and PivotTo then cancels
	it out and lays the whole display on its side. So the anchor is a plain
	unrotated block and the cylinder is just a child of it.
]]
local function buildRoot(model: Model, size: Vector3): BasePart
	local root = part("Root", size, Vector3.new(0, size.Y / 2, 0), PEDESTAL)
	root.Transparency = 1
	root.CanCollide = true
	root.Parent = model

	local pedestal = part("Pedestal", size, Vector3.new(0, size.Y / 2, 0), PEDESTAL, "Cylinder")
	pedestal.Parent = model
	return root
end

-- Clones the real R6 figure the user set up (ReplicatedStorage.StorefrontTemplates.MannequinR15)
-- and dresses it with the composited garment textures, instead of drawing a
-- placeholder box body.
local function buildMannequin(shirtTemplateId: string?, pantsTemplateId: string?): (Model, BasePart)
	local model = Instance.new("Model")
	local root = buildRoot(model, Vector3.new(4.2, 0.6, 4.2))

	local templates = game:GetService("ReplicatedStorage"):FindFirstChild("StorefrontTemplates")
	local source = templates and templates:FindFirstChild("MannequinR15")
	if not source then
		error("ComponentLibrary: ReplicatedStorage.StorefrontTemplates.MannequinR15 is missing")
	end

	local figure = source:Clone()
	figure.Name = "Figure"
	for _, inst in ipairs(figure:GetDescendants()) do
		if inst:IsA("BasePart") then
			inst.Anchored = true
			inst.CanCollide = false
		elseif inst:IsA("Humanoid") then
			inst.PlatformStand = true
		end
	end

	local shirt = figure:FindFirstChildOfClass("Shirt")
	if shirt and shirtTemplateId then
		shirt.ShirtTemplate = shirtTemplateId
	end
	local pants = figure:FindFirstChildOfClass("Pants")
	if pants and pantsTemplateId then
		pants.PantsTemplate = pantsTemplateId
	end

	figure.Parent = model

	-- Stand the clone on the pedestal: measure its own bounding box, then
	-- shift it so its feet meet the pedestal's top face. Measured rather than
	-- a hardcoded offset, since the source rig's height isn't ours to assume.
	figure:PivotTo(CFrame.new())
	local box, boxSize = figure:GetBoundingBox()
	local feetBelowPivot = box.Position.Y - boxSize.Y / 2
	local pedestalTopY = root.Position.Y + root.Size.Y / 2
	figure:PivotTo(CFrame.new(root.Position.X, pedestalTopY - feetBelowPivot, root.Position.Z))
	local figureTopY = pedestalTopY + boxSize.Y

	addSign(model, figureTopY + 1.4)
	addBillboard(model, root, figureTopY + 3.0)
	return model, root
end

local function buildPlushStand(bodyColour: Color3): (Model, BasePart)
	local model = Instance.new("Model")
	local root = buildRoot(model, Vector3.new(3.6, 2.4, 3.6))

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
		model, root = buildMannequin(spec.shirtTemplateId, spec.pantsTemplateId)
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
	prompt.ActionText = spec.ctaText or "Buy now"
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
	model:SetAttribute("ctaText", spec.ctaText or "Buy now")
	model:SetAttribute("signageText", spec.signageText or spec.title or "")
	model:SetAttribute("garmentColour", spec.garmentColour or SHELL)
	model:SetAttribute("imageAssetId", spec.imageAssetId)
	-- Populated once the AI-composited texture pipeline exists; until then,
	-- Try On falls back to a stock catalog template so the mechanism is
	-- demonstrable today without pretending it is the real product.
	model:SetAttribute("shirtTemplateId", spec.shirtTemplateId)
	model:SetAttribute("pantsTemplateId", spec.pantsTemplateId)
	model:SetAttribute("garmentOnLegs", spec.garmentOnLegs == true)

	ComponentLibrary.refreshText(model)
	CollectionService:AddTag(model, "StorefrontComponent")
	return model
end

--[[
	Replaces a display's placeholder geometry with a generated model, keeping
	the pedestal, sign, billboard and prompt intact.

	The placeholder shapes exist so the funnel can be measured before any art
	exists; this swaps in the real thing once it has been generated from the
	product photo, without disturbing anything telemetry depends on.
]]
local PLACEHOLDER_PARTS = {
	"Body", "Neck", "Head", "Beak",
	"Legs", "Torso", "ArmLeft", "ArmRight",
	"Garment", "GarmentSleeveL", "GarmentSleeveR",
}

function ComponentLibrary.attachProductArt(model: Model, source: Model, targetHeight: number?)
	local root = model.PrimaryPart
	if not root then return false, "component has no PrimaryPart" end

	local existing = model:FindFirstChild("ProductArt")
	if existing then existing:Destroy() end
	for _, name in ipairs(PLACEHOLDER_PARTS) do
		local part = model:FindFirstChild(name)
		if part then part:Destroy() end
	end

	local art = source:Clone()
	art.Name = "ProductArt"
	art.Parent = model

	local _, size = art:GetBoundingBox()
	local height = targetHeight or 3
	if size.Y > 0.001 then
		art:ScaleTo(height / size.Y)
	end

	local _, scaled = art:GetBoundingBox()
	local top = root.Position.Y + root.Size.Y / 2
	local centre = Vector3.new(root.Position.X, top + scaled.Y / 2, root.Position.Z)
	art:PivotTo(CFrame.lookAt(centre, centre + model:GetPivot().LookVector))

	-- Generated parts arrive unanchored and collidable, which would drop them
	-- through the floor and let players shove the merchandise around.
	for _, d in ipairs(art:GetDescendants()) do
		if d:IsA("BasePart") then
			d.Anchored = true
			d.CanCollide = false
		end
	end

	model:SetAttribute("artSource", "generated_from_shopify_image")
	return true
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
			prompt.ActionText = model:GetAttribute("ctaText") or "Buy now"
			prompt.ObjectText = model:GetAttribute("title") or model.Name
			prompt.Enabled = model:GetAttribute("interactionEnabled") ~= false
		end
	end
end

-- Re-applies the garment templates baked onto the Figure's Shirt/Pants at
-- build time from the model's current attributes. Needed after anything that
-- changes shirtTemplateId/pantsTemplateId post-build (swap_products) --
-- unlike text labels, these are Instance properties set once in
-- buildMannequin and never re-read from attributes on their own.
function ComponentLibrary.refreshGarment(model: Model)
	local figure = model:FindFirstChild("Figure")
	if not figure then return end

	local shirt = figure:FindFirstChildOfClass("Shirt")
	if shirt then
		shirt.ShirtTemplate = model:GetAttribute("shirtTemplateId") or ""
	end
	local pants = figure:FindFirstChildOfClass("Pants")
	if pants then
		pants.PantsTemplate = model:GetAttribute("pantsTemplateId") or ""
	end
end

return ComponentLibrary
