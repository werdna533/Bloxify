--!strict
-- Session bookkeeping plus everything the server can observe on its own:
-- proximity, dwell, prompt triggers and walking paths.
--
-- Camera-derived signals (gaze, impressions) cannot be computed here — the
-- server knows where a character faces, not where the camera points — so those
-- arrive from the client over a RemoteEvent and are clamped before use.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Telemetry = require(script.Parent.Telemetry)

local APPROACH_RADIUS = 12
local PATH_SAMPLE_STUDS = 2
local TICK = 0.25
local IDLE_TIMEOUT = 60

local shared = ReplicatedStorage:FindFirstChild("Shared")
if not shared then
	shared = Instance.new("Folder")
	shared.Name = "Shared"
	shared.Parent = ReplicatedStorage
end

local remote = shared:FindFirstChild("TelemetryRemote") :: RemoteEvent?
if not remote then
	remote = Instance.new("RemoteEvent")
	remote.Name = "TelemetryRemote"
	remote.Parent = shared
end

type Near = {
	enteredAt: number,
	minDistance: number,
	minSpeed: number,
	interacted: boolean,
	bearing: number,
	gazed: boolean,
}
type Session = {
	id: string,
	startedAt: number,
	lastPos: Vector3?,
	lastActivity: number,
	near: { [string]: Near },
	visited: { [string]: boolean },
}

local sessions: { [Player]: Session } = {}

local function now(): number
	return os.time() + (os.clock() % 1)
end

local function componentOf(model: Model): string
	return model:GetAttribute("componentId") or model.Name
end

local function push(session: Session, event: { [string]: any })
	-- An empty Luau table encodes as [] rather than {}, which does not match
	-- the ingest schema, so drop the key entirely when there is no metadata.
	if event.meta ~= nil and next(event.meta) == nil then
		event.meta = nil
	end
	Telemetry.push(session.id, event)
end

-- ------------------------------------------------------------------ sessions

local function startSession(player: Player)
	-- A random id per join. No Roblox UserIds or usernames are ever sent.
	local session: Session = {
		id = HttpService:GenerateGUID(false),
		startedAt = now(),
		lastPos = nil,
		lastActivity = os.clock(),
		near = {},
		visited = {},
	}
	sessions[player] = session
	push(session, { t = session.startedAt, type = "session_started" })
end

local function endSession(player: Player)
	local session = sessions[player]
	if not session then return end

	-- Close any dwell still open so the funnel is not left with a dangling approach.
	for componentId, near in pairs(session.near) do
		push(session, {
			t = now(),
			type = "display_dwell",
			surface = "physical",
			componentId = componentId,
			meta = {
				dwellSeconds = os.clock() - near.enteredAt,
				minDistance = near.minDistance,
				minSpeed = near.minSpeed,
				hadLineOfSight = near.bearing < 90,
				closedBy = "session_end",
			},
		})
	end

	local t = now()
	push(session, {
		t = t,
		type = "session_ended",
		meta = { durationSeconds = t - session.startedAt },
	})
	sessions[player] = nil
	Telemetry.flush()
end

Players.PlayerAdded:Connect(startSession)
Players.PlayerRemoving:Connect(endSession)
for _, player in ipairs(Players:GetPlayers()) do
	if not sessions[player] then startSession(player) end
end

-- ------------------------------------------------------------ prompt wiring

local function wirePrompt(model: Model)
	local root = model.PrimaryPart
	if not root then return end
	local prompt = root:FindFirstChild("InspectPrompt")
	if not prompt or not prompt:IsA("ProximityPrompt") then return end

	prompt.Triggered:Connect(function(player: Player)
		local session = sessions[player]
		if not session then return end
		session.lastActivity = os.clock()

		local componentId = componentOf(model)
		local near = session.near[componentId]
		if near then near.interacted = true end

		push(session, {
			t = now(),
			type = "display_interacted",
			surface = "physical",
			componentId = componentId,
			productId = model:GetAttribute("productId"),
			meta = { holdSeconds = prompt.HoldDuration },
		})
	end)
end

for _, model in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
	if model:IsA("Model") then wirePrompt(model) end
end
CollectionService:GetInstanceAddedSignal("StorefrontComponent"):Connect(function(instance)
	if instance:IsA("Model") then wirePrompt(instance) end
end)

-- ------------------------------------------------------- client-sent signals

local CLIENT_TYPES = {
	display_gaze = true,
	display_impression = true,
	display_hesitation = true,
	panel_opened = true,
	panel_engaged = true,
	panel_cta_clicked = true,
	panel_closed = true,
}

local NUMBER_CAPS = {
	gazeSeconds = 300,
	openSeconds = 600,
	activeSeconds = 600,
	distance = 500,
}

remote.OnServerEvent:Connect(function(player: Player, payload: any)
	local session = sessions[player]
	if not session then return end
	if typeof(payload) ~= "table" then return end
	if not CLIENT_TYPES[payload.type] then return end

	session.lastActivity = os.clock()

	-- Clients can lie. Clamp anything numeric so one bad message cannot wreck
	-- the averages on stage.
	local meta = {}
	if typeof(payload.meta) == "table" then
		for key, value in pairs(payload.meta) do
			if typeof(value) == "number" then
				local cap = NUMBER_CAPS[key]
				meta[key] = cap and math.clamp(value, 0, cap) or value
			elseif typeof(value) == "string" and #value <= 64 then
				meta[key] = value
			elseif typeof(value) == "boolean" then
				meta[key] = value
			end
		end
	end

	local componentId = typeof(payload.componentId) == "string" and payload.componentId or nil
	local productId = nil
	if componentId then
		for _, model in ipairs(CollectionService:GetTagged("StorefrontComponent")) do
			if componentOf(model) == componentId then
				productId = model:GetAttribute("productId")
				break
			end
		end
		-- Unknown component id means a stale or spoofed client; drop it.
		if not productId then return end
	end

	-- Remember that they looked, so a dwell that ends without an interaction can
	-- be told apart from one where they never even glanced at it.
	if payload.type == "display_gaze" and componentId then
		local near = session.near[componentId]
		if near then near.gazed = true end
	end

	push(session, {
		t = now(),
		type = payload.type,
		surface = payload.surface == "gui" and "gui" or "physical",
		componentId = componentId,
		productId = productId,
		meta = meta,
	})
end)

-- ------------------------------------------------------------- proximity loop

local accumulator = 0
RunService.Heartbeat:Connect(function(delta: number)
	accumulator += delta
	if accumulator < TICK then
		Telemetry.maybeFlush()
		return
	end
	accumulator = 0

	local components = CollectionService:GetTagged("StorefrontComponent")

	for player, session in pairs(sessions) do
		local character = player.Character
		local root = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
		if root then
			local pos = root.Position
			local speed = root.AssemblyLinearVelocity.Magnitude
			local idle = (os.clock() - session.lastActivity) > IDLE_TIMEOUT

			-- Only sample when they actually moved, or the path table fills with
			-- thousands of identical standing-still points.
			if not session.lastPos or (pos - session.lastPos).Magnitude > PATH_SAMPLE_STUDS then
				session.lastPos = pos
				session.lastActivity = os.clock()
				local look = root.CFrame.LookVector
				push(session, {
					t = now(),
					type = "path_point",
					pos = { pos.X, pos.Y, pos.Z },
					look = { look.X, look.Y, look.Z },
				})
			end

			for _, model in ipairs(components) do
				if model:IsA("Model") then
					local componentId = componentOf(model)
					local target = model:GetPivot().Position
					local distance = (target - pos).Magnitude
					local near = session.near[componentId]

					if distance <= APPROACH_RADIUS and not idle then
						if not near then
							local toPlayer = (pos - target)
							local facing = model:GetPivot().LookVector
							local flatToPlayer = Vector3.new(toPlayer.X, 0, toPlayer.Z)
							local flatFacing = Vector3.new(facing.X, 0, facing.Z)
							local bearing = 0
							if flatToPlayer.Magnitude > 0.01 and flatFacing.Magnitude > 0.01 then
								local dot = flatFacing.Unit:Dot(flatToPlayer.Unit)
								bearing = math.deg(math.acos(math.clamp(dot, -1, 1)))
							end

							session.near[componentId] = {
								enteredAt = os.clock(),
								minDistance = distance,
								minSpeed = speed,
								interacted = false,
								bearing = bearing,
								gazed = false,
							}
							-- Coming back after seeing something else is comparison
							-- shopping, which is a much stronger signal here than a
							-- browser back button.
							local eventType = session.visited[componentId] and "display_revisit" or "display_approach"
							session.visited[componentId] = true

							push(session, {
								t = now(),
								type = eventType,
								surface = "physical",
								componentId = componentId,
								productId = model:GetAttribute("productId"),
								pos = { pos.X, pos.Y, pos.Z },
								meta = {
									approachBearing = bearing,
									entrySpeed = speed,
									fromSlot = model:GetAttribute("slotId"),
								},
							})
						else
							near.minDistance = math.min(near.minDistance, distance)
							near.minSpeed = math.min(near.minSpeed, speed)
						end
					elseif near then
						-- Slowed down, looked at it, and still walked off without
						-- touching it: interested but not convinced.
						if near.gazed and not near.interacted and near.minSpeed < 8 then
							push(session, {
								t = now(),
								type = "display_hesitation",
								surface = "physical",
								componentId = componentId,
								productId = model:GetAttribute("productId"),
								meta = {
									minSpeed = near.minSpeed,
									dwellSeconds = os.clock() - near.enteredAt,
								},
							})
						end

						push(session, {
							t = now(),
							type = "display_dwell",
							surface = "physical",
							componentId = componentId,
							productId = model:GetAttribute("productId"),
							meta = {
								dwellSeconds = os.clock() - near.enteredAt,
								minDistance = near.minDistance,
								minSpeed = near.minSpeed,
								hadLineOfSight = near.bearing < 90,
							},
						})
						session.near[componentId] = nil
					end
				end
			end
		end
	end

	Telemetry.maybeFlush()
end)

game:BindToClose(function()
	for player in pairs(sessions) do
		endSession(player)
	end
	Telemetry.flush()
	task.wait(0.5)
end)

print("[telemetry] server tracking active")
