--!strict
-- The 2D product panel. Time spent here is deliberate consideration, which is
-- a different thing from standing near a display, so it is reported
-- separately and never added to dwell time.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local remote = ReplicatedStorage:WaitForChild("Shared"):WaitForChild("TelemetryRemote") :: RemoteEvent

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

	gui:Destroy()
	gui = nil
	state = nil
end

local function build(model: Model, openMethod: string)
	local componentId = model:GetAttribute("componentId")

	ProductPanel.close("replaced")
	state = {
		anchorComponentId = componentId,
		componentId = componentId,
		openedAt = os.clock(),
		lastAction = os.clock(),
		activeSeconds = 0,
		clicked = false,
	}

	local screen = Instance.new("ScreenGui")
	screen.Name = "ProductPanel"
	screen.ResetOnSpawn = false
	screen.Parent = player:WaitForChild("PlayerGui")
	gui = screen

	local frame = Instance.new("Frame")
	frame.Name = "PanelFrame"
	frame.Size = UDim2.fromOffset(460, 350)
	frame.Position = UDim2.new(0.5, -230, 0.5, -175)
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
		cta.Text = "Loading..."
		cta.BackgroundColor3 = Color3.fromRGB(70, 110, 160)
		-- Still mints a real claim code server-side (it's genuinely wired to
		-- Shopify), but the demo shows this as the moment the Roblox checkout
		-- experience would open, not a raw code, so the button stays on
		-- "Loading..." rather than surfacing the code itself.
		remote:FireServer({ type = "request_claim", componentId = componentId })
	end)

	report({
		type = "panel_opened",
		surface = "gui",
		componentId = componentId,
		meta = { openMethod = openMethod },
	})
end

function ProductPanel.open(model: Model, openMethod: string)
	build(model, openMethod)
end

-- The server minted (or failed to mint) a real Shopify discount code for the
-- product currently on screen; reflect the outcome on the CTA button itself.
remote.OnClientEvent:Connect(function(payload: any)
	if typeof(payload) ~= "table" or payload.type ~= "claim_result" then return end
	if not state or not gui or state.componentId ~= payload.componentId then return end
	local frame = gui:FindFirstChild("PanelFrame")
	local cta = frame and frame:FindFirstChild("CtaButton") :: TextButton?
	if not cta then return end

	if not payload.ok then
		-- Only a real failure changes anything visible, and even then it just
		-- quietly allows a retry -- the button keeps saying "Loading...".
		state.clicked = false
	end
end)

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
