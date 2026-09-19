--!strict
-- Camera-derived tracking. The server knows where a character faces, not where
-- the camera points, and in Roblox those differ constantly — so gaze and
-- impressions have to be computed here and sent over a RemoteEvent.
--
-- Sampled at 4Hz, not every frame, and debounced, because a camera wobbling
-- across a display would otherwise flood the backend.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local ProductPanel = require(script.Parent:WaitForChild("ProductPanel"))

local TICK = 0.25
local GAZE_DOT = 0.85
local GAZE_RANGE = 20
local GAZE_MIN_SECONDS = 0.75
local GAZE_GRACE = 0.5
local IMPRESSION_DOT = 0.5
local IMPRESSION_MIN_SECONDS = 0.5
local IMPRESSION_DEBOUNCE = 30
local IMPRESSION_MIN_DISTANCE = 20
local PANEL_WALKAWAY_DISTANCE = 22
local IDLE_TIMEOUT = 60

local player = Players.LocalPlayer
local camera = workspace.CurrentCamera

local remote = ReplicatedStorage:WaitForChild("Shared"):WaitForChild("TelemetryRemote") :: RemoteEvent

local function emit(event: { [string]: any })
	remote:FireServer(event)
end
ProductPanel.setEmitter(emit)

type GazeState = { startedAt: number, brokenAt: number?, emitted: boolean, distance: number }
type ImpressionState = { startedAt: number, lastEmitted: number }

local gaze: { [string]: GazeState } = {}
local impressions: { [string]: ImpressionState } = {}
local lastInputAt = os.clock()
local lastMovePos: Vector3? = nil

UserInputService.InputBegan:Connect(function() lastInputAt = os.clock() end)
UserInputService.InputChanged:Connect(function() lastInputAt = os.clock() end)

local rayParams = RaycastParams.new()
rayParams.FilterType = Enum.RaycastFilterType.Exclude

-- Rebuilt every tick rather than cached: a respawn swaps the Character
-- instance, and a stale reference means the ray hits the player's own body and
-- reports every display as blocked.
local function refreshRayFilter()
	local exclude: { Instance } = {}
	if player.Character then table.insert(exclude, player.Character) end
	for _, model in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
		table.insert(exclude, model)
	end
	rayParams.FilterDescendantsInstances = exclude
end

-- Proximity alone lies: a player can be five studs from a display with a wall
-- between them. Only run this for displays already pointing the right way.
local function hasLineOfSight(target: Vector3): boolean
	local origin = camera.CFrame.Position
	local direction = target - origin
	local hit = workspace:Raycast(origin, direction, rayParams)
	return hit == nil
end

local function openPanelFor(model: Model)
	ProductPanel.open(model, "prompt")
end

-- Wired lazily from the tick loop rather than once at startup. Tagged
-- instances replicate to the client on their own schedule, so a single scan
-- here races replication and silently leaves the panel unwired.
local wired: { [Instance]: boolean } = {}

local function ensureWired(model: Model)
	if wired[model] then return end
	local root = model.PrimaryPart
	if not root then return end
	local prompt = root:FindFirstChild("InspectPrompt")
	if not prompt or not prompt:IsA("ProximityPrompt") then return end

	wired[model] = true
	prompt.Triggered:Connect(function()
		lastInputAt = os.clock()
		openPanelFor(model)
	end)
end

local accumulator = 0
RunService.RenderStepped:Connect(function(delta: number)
	accumulator += delta
	if accumulator < TICK then return end
	accumulator = 0

	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not root then return end

	refreshRayFilter()

	local nowClock = os.clock()

	-- Moving counts as being active. Input events alone are not enough: they
	-- differ by device, and an automated playtest drives the character without
	-- ever raising one, which would silently suppress every attention event.
	if not lastMovePos or (root.Position - lastMovePos).Magnitude > 1 then
		lastMovePos = root.Position
		lastInputAt = nowClock
	end

	-- An AFK player would otherwise produce one twenty-minute attention event
	-- and destroy every average in the dashboard.
	local idle = (nowClock - lastInputAt) > IDLE_TIMEOUT

	local camPos = camera.CFrame.Position
	local camLook = camera.CFrame.LookVector

	for _, model in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
		if model:IsA("Model") then
			ensureWired(model)
			local componentId = model:GetAttribute("componentId")
			local target = model:GetPivot().Position + Vector3.new(0, 4, 0)
			local toTarget = target - camPos
			local distance = toTarget.Magnitude
			local dot = distance > 0.01 and camLook:Dot(toTarget.Unit) or 0

			-- ---- gaze: looking right at it, close, unobstructed ----
			local gazing = not idle
				and dot > GAZE_DOT
				and distance <= GAZE_RANGE
				and hasLineOfSight(target)

			local g = gaze[componentId]
			if gazing then
				if not g then
					gaze[componentId] = { startedAt = nowClock, brokenAt = nil, emitted = false, distance = distance }
				else
					g.brokenAt = nil
					g.distance = math.min(g.distance, distance)
				end
			elseif g then
				-- Short grace period so a wobbling camera does not chop one look
				-- into a dozen events.
				if not g.brokenAt then
					g.brokenAt = nowClock
				elseif nowClock - g.brokenAt >= GAZE_GRACE then
					local seconds = g.brokenAt - g.startedAt
					if seconds >= GAZE_MIN_SECONDS then
						emit({
							type = "display_gaze",
							surface = "physical",
							componentId = componentId,
							meta = { gazeSeconds = seconds, distance = g.distance },
						})
					end
					gaze[componentId] = nil
				end
			end

			-- ---- impression: it entered view from a distance ----
			-- This is what separates "never saw it" from "saw it and walked past",
			-- and nothing in 2D commerce has an equivalent.
			local visible = not idle
				and dot > IMPRESSION_DOT
				and distance > IMPRESSION_MIN_DISTANCE
				and hasLineOfSight(target)

			local imp = impressions[componentId]
			if visible then
				if not imp then
					impressions[componentId] = { startedAt = nowClock, lastEmitted = -math.huge }
				elseif nowClock - imp.startedAt >= IMPRESSION_MIN_SECONDS
					and nowClock - imp.lastEmitted >= IMPRESSION_DEBOUNCE then
					imp.lastEmitted = nowClock
					emit({
						type = "display_impression",
						surface = "physical",
						componentId = componentId,
						meta = { distance = distance },
					})
				end
			elseif imp then
				imp.startedAt = nowClock
			end
		end
	end

	-- Walking away from a panel is a different close reason than dismissing it.
	-- Measured against the display it was opened from, not whatever product is
	-- currently shown, or browsing the range would read as walking away.
	local openFor = ProductPanel.anchor()
	if openFor then
		local model = nil
		for _, candidate in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
			if candidate:GetAttribute("componentId") == openFor then model = candidate break end
		end
		if model then
			local distance = (model:GetPivot().Position - root.Position).Magnitude
			if distance > PANEL_WALKAWAY_DISTANCE then
				ProductPanel.close("walked_away")
			elseif idle then
				ProductPanel.close("idle_timeout")
			end
		end
	end
end)

print("[telemetry] client tracking active")
