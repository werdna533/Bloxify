--!strict
-- The 2D product panel. Time spent here is deliberate consideration, which is
-- a different thing from standing near a display, so it is reported
-- separately and never added to dwell time.

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")

-- Placeholder until the AI-composited texture pipeline exists: a real Roblox
-- catalog shirt/pants, so Try On has something to actually show today.
local FALLBACK_SHIRT = "http://www.roblox.com/asset/?id=4846089534"
local FALLBACK_PANTS = "http://www.roblox.com/asset/?id=382537568"

-- Remembers what the player was wearing so Take Off can restore it exactly,
-- including "wasn't wearing a Shirt/Pants at all".
local wornBefore: { shirt: string?, pants: string?, hadShirt: boolean, hadPants: boolean }? = nil

local function tryOn(model: Model)
	local character = Players.LocalPlayer.Character
	if not character then return end

	local shirt = character:FindFirstChildOfClass("Shirt")
	local pants = character:FindFirstChildOfClass("Pants")
	wornBefore = {
		shirt = shirt and shirt.ShirtTemplate or nil,
		pants = pants and pants.PantsTemplate or nil,
		hadShirt = shirt ~= nil,
		hadPants = pants ~= nil,
	}

	if not shirt then
		shirt = Instance.new("Shirt")
		shirt.Parent = character
	end
	if not pants then
		pants = Instance.new("Pants")
		pants.Parent = character
	end
	shirt.ShirtTemplate = model:GetAttribute("shirtTemplateId") or FALLBACK_SHIRT
	pants.PantsTemplate = model:GetAttribute("pantsTemplateId") or FALLBACK_PANTS
end

local function takeOff()
	if not wornBefore then return end
	local character = Players.LocalPlayer.Character
	if character then
		local shirt = character:FindFirstChildOfClass("Shirt")
		local pants = character:FindFirstChildOfClass("Pants")
		if shirt then
			if wornBefore.hadShirt then shirt.ShirtTemplate = wornBefore.shirt or "" else shirt:Destroy() end
		end
		if pants then
			if wornBefore.hadPants then pants.PantsTemplate = wornBefore.pants or "" else pants:Destroy() end
		end
	end
	wornBefore = nil
end

local ProductPanel = {}

local ACTIVE_WINDOW = 15 -- a panel left open while the player wanders is not "active"

local player = Players.LocalPlayer
local gui: ScreenGui? = nil
local state: {
	-- The display whose prompt opened this panel. Browsing to another product
	-- inside the panel does not change it, because "did they walk away" has to
	-- be measured against the thing they walked up to.
	anchorComponentId: string,
	componentId: string,
	openedAt: number,
	lastAction: number,
	activeSeconds: number,
	clicked: boolean,
}? = nil

local emit: ((event: { [string]: any }) -> ())? = nil

function ProductPanel.setEmitter(fn: (event: { [string]: any }) -> ())
	emit = fn
end

local function report(event: { [string]: any })
	if emit then emit(event) end
end

local function clothingComponents(): { Model }
	local out = {}
	for _, model in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
		if model:IsA("Model") and model:GetAttribute("kind") == "Mannequin" then
			table.insert(out, model)
		end
	end
	table.sort(out, function(a, b)
		return tostring(a:GetAttribute("componentId")) < tostring(b:GetAttribute("componentId"))
	end)
	return out
end

local function findComponent(componentId: string): Model?
	for _, model in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
		if model:GetAttribute("componentId") == componentId then return model :: Model end
	end
	return nil
end

local function touch(action: string, toComponentId: string?)
	if not state then return end
	local nowClock = os.clock()
	if nowClock - state.lastAction <= ACTIVE_WINDOW then
		state.activeSeconds += nowClock - state.lastAction
	end
	state.lastAction = nowClock

	local meta: { [string]: any } = { action = action }
	if toComponentId then
		-- Which item they browsed to. Attention this item earned while the
		-- player was standing at a different display is demand that placement
		-- did not create, and nothing else in the funnel can show it.
		meta.toComponentId = toComponentId
		meta.fromComponentId = state.anchorComponentId
	end

	report({ type = "panel_engaged", surface = "gui", componentId = state.componentId, meta = meta })
end

function ProductPanel.close(reason: string)
	if not state or not gui then return end
	local nowClock = os.clock()
	if nowClock - state.lastAction <= ACTIVE_WINDOW then
		state.activeSeconds += nowClock - state.lastAction
	end

	report({
		type = "panel_closed",
		surface = "gui",
		componentId = state.componentId,
		meta = {
			openSeconds = nowClock - state.openedAt,
			activeSeconds = state.activeSeconds,
			closeReason = reason,
		},
	})

	takeOff()
	gui:Destroy()
	gui = nil
	state = nil
end

-- keepSession rebuilds the contents for a different product without ending the
-- panel session: browsing the range is one visit with tab events inside it,
-- not several panel opens.
local function build(model: Model, openMethod: string, keepSession: boolean?)
	local componentId = model:GetAttribute("componentId")

	if keepSession and state and gui then
		local previous = state
		gui:Destroy()
		state = {
			anchorComponentId = previous.anchorComponentId,
			componentId = componentId,
			openedAt = previous.openedAt,
			lastAction = previous.lastAction,
			activeSeconds = previous.activeSeconds,
			-- Per product: browsing to a different item offers a fresh CTA.
			clicked = false,
		}
	else
		ProductPanel.close("replaced")
		state = {
			anchorComponentId = componentId,
			componentId = componentId,
			openedAt = os.clock(),
			lastAction = os.clock(),
			activeSeconds = 0,
			clicked = false,
		}
	end

	local screen = Instance.new("ScreenGui")
	screen.Name = "ProductPanel"
	screen.ResetOnSpawn = false
	screen.Parent = player:WaitForChild("PlayerGui")
	gui = screen

	local frame = Instance.new("Frame")
	frame.Name = "PanelFrame"
	-- Tall enough for image + price + range row + Try On + CTA without the
	-- bottom-anchored buttons overlapping the range row above them.
	frame.Size = UDim2.fromOffset(460, 480)
	frame.Position = UDim2.new(0.5, -230, 0.5, -240)
	frame.BackgroundColor3 = Color3.fromRGB(18, 18, 21)
	frame.BorderSizePixel = 0
	frame.Parent = screen
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 10)
	corner.Parent = frame

	local title = Instance.new("TextLabel")
	title.Size = UDim2.new(1, -90, 0, 40)
	title.Position = UDim2.fromOffset(18, 14)
	title.BackgroundTransparency = 1
	title.Font = Enum.Font.GothamBold
	title.TextSize = 22
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.TextColor3 = Color3.fromRGB(245, 245, 245)
	title.Text = model:GetAttribute("title") or componentId
	title.Parent = frame

	local price = Instance.new("TextLabel")
	price.Size = UDim2.new(1, -36, 0, 24)
	price.Position = UDim2.fromOffset(18, 50)
	price.BackgroundTransparency = 1
	price.Font = Enum.Font.Gotham
	price.TextSize = 17
	price.TextXAlignment = Enum.TextXAlignment.Left
	price.TextColor3 = Color3.fromRGB(150, 210, 255)
	price.Text = string.format("$%.2f", model:GetAttribute("price") or 0)
	price.Parent = frame

	-- The real listing photo, uploaded from Shopify to a Roblox asset id.
	-- Falls back to a flat colour when a product has no image yet.
	local art = Instance.new("Frame")
	art.Name = "ProductImage"
	art.Size = UDim2.new(1, -36, 0, 170)
	art.Position = UDim2.fromOffset(18, 84)
	art.BackgroundColor3 = Color3.fromRGB(244, 244, 246)
	art.BorderSizePixel = 0
	art.Parent = frame
	local artCorner = Instance.new("UICorner")
	artCorner.CornerRadius = UDim.new(0, 8)
	artCorner.Parent = art

	local assetId = model:GetAttribute("imageAssetId")
	if assetId then
		local photo = Instance.new("ImageLabel")
		photo.Name = "Photo"
		photo.Size = UDim2.fromScale(1, 1)
		photo.BackgroundTransparency = 1
		photo.ScaleType = Enum.ScaleType.Fit
		photo.Image = assetId
		photo.Parent = art
	else
		art.BackgroundColor3 = model:GetAttribute("garmentColour") or Color3.fromRGB(80, 80, 90)
		local note = Instance.new("TextLabel")
		note.Size = UDim2.fromScale(1, 1)
		note.BackgroundTransparency = 1
		note.Font = Enum.Font.Gotham
		note.TextSize = 12
		note.TextColor3 = Color3.fromRGB(255, 255, 255)
		note.TextTransparency = 0.45
		note.Text = "no product image"
		note.Parent = art
	end

	local closeButton = Instance.new("TextButton")
	closeButton.Name = "CloseButton"
	closeButton.Size = UDim2.fromOffset(34, 34)
	closeButton.Position = UDim2.new(1, -46, 0, 14)
	closeButton.BackgroundColor3 = Color3.fromRGB(40, 40, 46)
	closeButton.Font = Enum.Font.GothamBold
	closeButton.TextSize = 16
	closeButton.TextColor3 = Color3.fromRGB(230, 230, 230)
	closeButton.Text = "X"
	closeButton.Parent = frame
	local closeCorner = Instance.new("UICorner")
	closeCorner.CornerRadius = UDim.new(0, 6)
	closeCorner.Parent = closeButton
	closeButton.Activated:Connect(function() ProductPanel.close("manual") end)

	local cta = Instance.new("TextButton")
	cta.Name = "CtaButton"
	cta.Size = UDim2.new(1, -36, 0, 44)
	cta.Position = UDim2.new(0, 18, 1, -62)
	cta.BackgroundColor3 = Color3.fromRGB(56, 190, 130)
	cta.Font = Enum.Font.GothamBold
	cta.TextSize = 16
	cta.TextColor3 = Color3.fromRGB(10, 20, 16)
	cta.Text = model:GetAttribute("ctaText") or "Get it"
	cta.Parent = frame
	local ctaCorner = Instance.new("UICorner")
	ctaCorner.CornerRadius = UDim.new(0, 8)
	ctaCorner.Parent = cta

	cta.Activated:Connect(function()
		if not state or state.clicked then return end
		state.clicked = true
		state.lastAction = os.clock()
		report({ type = "panel_cta_clicked", surface = "gui", componentId = componentId })
		cta.Text = "Check your phone for the code"
		cta.BackgroundColor3 = Color3.fromRGB(70, 110, 160)
	end)

	if model:GetAttribute("kind") == "Mannequin" then
		local tryOnButton = Instance.new("TextButton")
		tryOnButton.Name = "TryOnButton"
		tryOnButton.Size = UDim2.new(1, -36, 0, 34)
		tryOnButton.Position = UDim2.new(0, 18, 1, -102)
		tryOnButton.BackgroundColor3 = Color3.fromRGB(60, 62, 70)
		tryOnButton.Font = Enum.Font.GothamBold
		tryOnButton.TextSize = 14
		tryOnButton.TextColor3 = Color3.fromRGB(240, 240, 240)
		tryOnButton.Text = "Try On"
		tryOnButton.Parent = frame
		local tryOnCorner = Instance.new("UICorner")
		tryOnCorner.CornerRadius = UDim.new(0, 8)
		tryOnCorner.Parent = tryOnButton

		local trying = false
		tryOnButton.Activated:Connect(function()
			touch("try_on")
			trying = not trying
			if trying then
				tryOn(model)
				tryOnButton.Text = "Take Off"
			else
				takeOff()
				tryOnButton.Text = "Try On"
			end
		end)
	end

	-- Clothing panels also list the rest of the clothing range; the plush goose
	-- gets a single-product panel.
	if model:GetAttribute("kind") == "Mannequin" then
		local label = Instance.new("TextLabel")
		label.Size = UDim2.new(1, -36, 0, 16)
		label.Position = UDim2.fromOffset(18, 264)
		label.BackgroundTransparency = 1
		label.Font = Enum.Font.Gotham
		label.TextSize = 11
		label.TextXAlignment = Enum.TextXAlignment.Left
		label.TextColor3 = Color3.fromRGB(130, 130, 140)
		label.Text = "MORE FROM THIS RANGE"
		label.Parent = frame

		local row = Instance.new("Frame")
		row.Name = "RangeRow"
		row.Size = UDim2.new(1, -36, 0, 74)
		row.Position = UDim2.fromOffset(18, 284)
		row.BackgroundTransparency = 1
		row.Parent = frame

		local layout = Instance.new("UIListLayout")
		layout.FillDirection = Enum.FillDirection.Horizontal
		layout.Padding = UDim.new(0, 8)
		layout.Parent = row

		for _, other in ipairs(clothingComponents()) do
			local otherId = other:GetAttribute("componentId")
			local otherAsset = other:GetAttribute("imageAssetId")

			-- Product photo with rounded corners, matching the main image above,
			-- rather than a flat colour block standing in for the item.
			local swatch = Instance.new("ImageButton")
			swatch.Name = "Swatch_" .. otherId
			swatch.Size = UDim2.fromOffset(98, 74)
			swatch.BackgroundColor3 = otherAsset and Color3.fromRGB(244, 244, 246)
				or (other:GetAttribute("garmentColour") or Color3.fromRGB(70, 70, 80))
			swatch.Image = otherAsset or ""
			swatch.ScaleType = Enum.ScaleType.Fit
			swatch.AutoButtonColor = otherId ~= componentId
			swatch.Parent = row
			local sc = Instance.new("UICorner")
			sc.CornerRadius = UDim.new(0, 8)
			sc.Parent = swatch

			-- Name caption on a translucent strip along the bottom, so the photo
			-- is not competing with text drawn over it.
			local caption = Instance.new("Frame")
			caption.Size = UDim2.new(1, 0, 0, 20)
			caption.Position = UDim2.new(0, 0, 1, -20)
			caption.BackgroundColor3 = Color3.fromRGB(10, 10, 12)
			caption.BackgroundTransparency = 0.25
			caption.BorderSizePixel = 0
			caption.Parent = swatch
			local captionCorner = Instance.new("UICorner")
			captionCorner.CornerRadius = UDim.new(0, 8)
			captionCorner.Parent = caption
			-- Square off the top of the strip so only the bottom stays rounded.
			local captionFix = Instance.new("Frame")
			captionFix.Size = UDim2.new(1, 0, 0, 8)
			captionFix.BackgroundColor3 = caption.BackgroundColor3
			captionFix.BackgroundTransparency = caption.BackgroundTransparency
			captionFix.BorderSizePixel = 0
			captionFix.Parent = caption

			local captionLabel = Instance.new("TextLabel")
			captionLabel.Size = UDim2.fromScale(1, 1)
			captionLabel.BackgroundTransparency = 1
			captionLabel.Font = Enum.Font.Gotham
			captionLabel.TextSize = 10
			captionLabel.TextColor3 = Color3.fromRGB(255, 255, 255)
			captionLabel.Text = other:GetAttribute("signageText") or otherId
			captionLabel.Parent = caption

			if otherId == componentId then
				local border = Instance.new("UIStroke")
				border.Color = Color3.fromRGB(255, 255, 255)
				border.Thickness = 2
				border.Parent = swatch
			else
				swatch.Activated:Connect(function()
					touch("tab", otherId)
					local target = findComponent(otherId)
					if target then build(target, "tab", true) end
				end)
			end
		end
	end

	if not keepSession then
		report({
			type = "panel_opened",
			surface = "gui",
			componentId = componentId,
			meta = { openMethod = openMethod },
		})
	end
end

function ProductPanel.open(model: Model, openMethod: string)
	build(model, openMethod)
end

function ProductPanel.isOpenFor(componentId: string): boolean
	return state ~= nil and state.componentId == componentId
end

function ProductPanel.current(): string?
	return state and state.componentId or nil
end

-- The display this panel was opened from, which is what distance is judged against.
function ProductPanel.anchor(): string?
	return state and state.anchorComponentId or nil
end

return ProductPanel
