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

local backoffUntil = 0

-- One request carries every session. Sending per player would cost roughly
-- 20 requests/minute each, and HttpService allows about 500/minute for the
-- whole server, so a full lobby would be throttled within seconds.
local function send(batch: { { [string]: any } })
	local ok, err = pcall(function()
		local res = HttpService:RequestAsync({
			Url = Config.BASE_URL .. "/api/events",
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
				["Authorization"] = "Bearer " .. Config.AUTH_TOKEN,
			},
			Body = HttpService:JSONEncode({ batch = batch }),
		})
		if not res.Success then
			warn(string.format("[telemetry] backend replied %d: %s", res.StatusCode, tostring(res.Body)))
			-- Throttled or server-side trouble: stop hammering it for a bit.
			if res.StatusCode == 429 or res.StatusCode >= 500 then
				backoffUntil = os.clock() + 15
			end
		end
	end)
	if not ok then
		-- A dead backend must never break the game during a demo.
		warn("[telemetry] send failed:", err)
		backoffUntil = os.clock() + 15
	end
end

function Telemetry.flush()
	if #queue == 0 then
		lastFlush = os.clock()
		return
	end
	if os.clock() < backoffUntil then
		-- Still backing off. Leave the queue alone; MAX_QUEUE caps the damage.
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

	local batch = {}
	local currentExperiment = experimentId()
	for sessionId, events in pairs(bySession) do
		table.insert(batch, {
			sessionId = sessionId,
			placeVersion = Config.PLACE_VERSION,
			experimentId = currentExperiment,
			source = "live",
			events = events,
		})
	end

	task.spawn(send, batch)
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
