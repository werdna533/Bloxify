--!strict
-- Batched sender. HttpService is server-only and rate limited to roughly 500
-- requests/minute per server, so events are queued and flushed in bundles.

local HttpService = game:GetService("HttpService")
local Config = require(game:GetService("ServerScriptService").Storefront.Config)

local Telemetry = {}

local queue: { { sessionId: string, event: { [string]: any } } } = {}
local lastFlush = os.clock()
local dropped = 0

local function experimentId(): string
	return workspace:GetAttribute("ExperimentId") or "exp_baseline"
end

function Telemetry.push(sessionId: string, event: { [string]: any })
	if #queue >= Config.MAX_QUEUE then
		-- Never grow unbounded; a dead backend must not eat the server's memory.
		dropped += 1
		if dropped % 100 == 1 then
			warn(string.format("[telemetry] queue full, dropped %d events", dropped))
		end
		return
	end
	table.insert(queue, { sessionId = sessionId, event = event })
end

local function send(sessionId: string, events: { { [string]: any } })
	local payload = {
		sessionId = sessionId,
		placeVersion = Config.PLACE_VERSION,
		experimentId = experimentId(),
		source = "live",
		events = events,
	}

	-- A dead backend must never break the game during a demo.
	local ok, err = pcall(function()
		local res = HttpService:RequestAsync({
			Url = Config.BASE_URL .. "/api/events",
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
				["Authorization"] = "Bearer " .. Config.AUTH_TOKEN,
			},
			Body = HttpService:JSONEncode(payload),
		})
		if not res.Success then
			warn(string.format("[telemetry] backend replied %d: %s", res.StatusCode, tostring(res.Body)))
		end
	end)
	if not ok then
		warn("[telemetry] send failed:", err)
	end
end

function Telemetry.flush()
	if #queue == 0 then
		lastFlush = os.clock()
		return
	end

	local bySession: { [string]: { { [string]: any } } } = {}
	for _, entry in ipairs(queue) do
		local list = bySession[entry.sessionId]
		if not list then
			list = {}
			bySession[entry.sessionId] = list
		end
		table.insert(list, entry.event)
	end
	queue = {}
	lastFlush = os.clock()

	for sessionId, events in pairs(bySession) do
		task.spawn(send, sessionId, events)
	end
end

function Telemetry.maybeFlush()
	if #queue >= Config.FLUSH_EVENTS or (os.clock() - lastFlush) >= Config.FLUSH_SECONDS then
		Telemetry.flush()
	end
end

function Telemetry.stats(): { queued: number, dropped: number }
	return { queued = #queue, dropped = dropped }
end

return Telemetry
