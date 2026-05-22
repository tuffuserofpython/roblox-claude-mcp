--[[
	MCPBridge — single-script Roblox <-> Claude Code integration.

	WHAT IT IS
	  ONE server Script. Drop it in ServerScriptService. It streams live game
	  events to the local MCP bridge (Node) and executes commands Claude sends
	  back. There is no second script to install: client-only signals (raw input,
	  GUI button clicks) are captured by a tiny LocalScript this script GENERATES
	  at runtime when CONFIG.InjectClientCollector is true.

	HOW IT TALKS
	  Roblox HttpService can only make outbound requests, so this script:
	    - POSTs batched events to  <ApiUrl>/events
	    - POSTs state snapshots to  <ApiUrl>/state
	    - long-polls GET           <ApiUrl>/poll   for commands
	    - POSTs command results to  <ApiUrl>/results

	REQUIREMENTS
	  - Game Settings > Security > "Allow HTTP Requests" = ON.
	  - For roblox_run_luau: ServerScriptService.LoadStringEnabled = ON
	    (Studio: select ServerScriptService, tick LoadStringEnabled).
]]

--========================= CONFIG ============================================
local CONFIG = {
	ApiUrl = "http://127.0.0.1:7777", -- where the Node bridge listens
	AuthKey = "", -- must match ROBLOX_MCP_KEY on the Node side ("" = off)

	-- Cadence
	FlushInterval = 0.4, -- seconds between event-batch POSTs
	StateInterval = 1.0, -- seconds between state-snapshot POSTs
	MovementInterval = 0.25, -- seconds between movement samples per player
	MovementThreshold = 3, -- studs moved before a movement event is emitted
	MaxBatch = 120, -- max events per POST

	-- Capture toggles
	CaptureMovement = true,
	CaptureJumps = true,
	CaptureClicks = true, -- ClickDetectors (server-visible)
	CaptureClickHandlers = true, -- EXECUTOR ONLY: resolve which script(s)/line handle a click via getconnections+debug.info
	CaptureTools = true,
	CaptureRemotes = true, -- wrap RemoteEvents/RemoteFunctions
	CaptureCharacter = true, -- health, died, humanoid state
	CaptureObjects = true, -- DescendantAdded/Removed across watched roots
	WatchedRoots = { "Workspace" }, -- service names to watch for object changes

	-- "Capture everything" toggles: output, errors, chat
	CaptureLogs = true, -- LogService.MessageOut: every print/warn/error from any script
	CaptureErrors = true, -- ScriptContext.Error: runtime errors with script path + traceback
	CaptureChat = true, -- player chat messages
	MaxLogLength = 500, -- truncate long log lines

	InjectClientCollector = true, -- generate a LocalScript for GUI + raw input

	Verbose = false,
}
--=============================================================================

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")
local ServerStorage = game:GetService("ServerStorage")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local StarterPlayer = game:GetService("StarterPlayer")
local LogService = game:GetService("LogService")
local ScriptContext = game:GetService("ScriptContext")

-- Capture executor HTTP functions before defining local overrides
local executorRequest = (syn and syn.request) or http_request or (type(request) == "function" and request or nil)
local isExecutor = executorRequest ~= nil

local function log(...)
	if CONFIG.Verbose then
		print("[MCPBridge]", ...)
	end
end
local function warnLog(...)
	warn("[MCPBridge]", ...)
end

-- Halts if run on a normal client without an executor context.
if not RunService:IsServer() and not isExecutor then
	warnLog(
		"MCPBridge must run on the SERVER. Put it in ServerScriptService as a"
			.. " regular Script (RunContext = Legacy/Server), not a LocalScript."
			.. " Halting on this client."
	)
	return
end

--========================= HTTP helpers ======================================
local function headers()
	local h = { ["Content-Type"] = "application/json" }
	if CONFIG.AuthKey ~= "" then
		h["x-roblox-key"] = CONFIG.AuthKey
	end
	return h
end

local function request(method, path, body)
	local options = {
		Url = CONFIG.ApiUrl .. path,
		Method = method,
		Headers = headers(),
		Body = body and HttpService:JSONEncode(body) or nil,
	}

	local ok, res = pcall(function()
		if executorRequest then
			return executorRequest(options)
		else
			return HttpService:RequestAsync(options)
		end
	end)

	if not ok then
		return nil, tostring(res)
	end

	-- Normalize differences between HttpService and executor responses
	local statusCode = res.StatusCode or res.status or 0
	local success = res.Success
	if success == nil then
		success = (statusCode >= 200 and statusCode < 300)
	end
	local statusMessage = res.StatusMessage or res.status_text or res.StatusDescription or ""

	if not success then
		return nil, ("HTTP %d %s"):format(statusCode, statusMessage)
	end

	local decoded = nil
	if res.Body and #res.Body > 0 then
		local dok, d = pcall(function()
			return HttpService:JSONDecode(res.Body)
		end)
		if dok then
			decoded = d
		end
	end
	return decoded or {}, nil
end

--========================= Event buffer ======================================
local eventBuffer = {}

local function emit(eventType, action, player, data)
	local ev = {
		type = eventType,
		action = action,
		gameTime = os.clock(),
		data = data,
	}
	if player then
		ev.userId = player.UserId
		ev.playerName = player.Name
	end
	table.insert(eventBuffer, ev)
	-- Hard cap so a stalled bridge can't blow up memory.
	if #eventBuffer > CONFIG.MaxBatch * 10 then
		table.remove(eventBuffer, 1)
	end
end

-- Public custom-event API for game code: _G.MCP.emit("score", {value=10})
_G.MCP = {
	emit = function(name, data)
		emit("custom", tostring(name), nil, data)
	end,
	emitForPlayer = function(player, name, data)
		emit("custom", tostring(name), player, data)
	end,
}
-- Also accept a BindableEvent named "MCPCustomEvent" if the dev prefers that.
do
	local be = ServerStorage:FindFirstChild("MCPCustomEvent")
	if not be then
		be = Instance.new("BindableEvent")
		be.Name = "MCPCustomEvent"
		be.Parent = ServerStorage
	end
	be.Event:Connect(function(name, data)
		emit("custom", tostring(name), nil, data)
	end)
end

local function flushEvents()
	if #eventBuffer == 0 then
		return
	end
	local batch = {}
	for _ = 1, math.min(#eventBuffer, CONFIG.MaxBatch) do
		table.insert(batch, table.remove(eventBuffer, 1))
	end
	local _, err = request("POST", "/events", batch)
	if err then
		warnLog("flush failed:", err)
		-- Put unsent events back at the front so nothing is lost.
		for i = #batch, 1, -1 do
			table.insert(eventBuffer, 1, batch[i])
		end
	end
end

--========================= Value coercion ====================================
-- Convert JSON values from Claude into Roblox datatypes for property setting.
local function coerceValue(v)
	if type(v) == "table" then
		if v.x ~= nil and v.y ~= nil and v.z ~= nil then
			return Vector3.new(v.x, v.y, v.z)
		end
		if v.r ~= nil and v.g ~= nil and v.b ~= nil then
			return Color3.new(v.r, v.g, v.b)
		end
		if v.x ~= nil and v.y ~= nil then
			return Vector2.new(v.x, v.y)
		end
	end
	return v
end

local function vec3(v3)
	return { v3.X, v3.Y, v3.Z }
end

--========================= Path resolution ===================================
-- Resolve "Workspace.Folder.Part" starting from `game`.
local function resolvePath(path)
	if not path or path == "" then
		return nil, "empty path"
	end
	local node = game
	for segment in string.gmatch(path, "[^%.]+") do
		if node == game then
			-- first segment is a service or top-level child
			local ok, svc = pcall(function()
				return game:GetService(segment)
			end)
			node = (ok and svc) or game:FindFirstChild(segment)
		else
			node = node:FindFirstChild(segment)
		end
		if not node then
			return nil, "not found at segment '" .. segment .. "'"
		end
	end
	return node, nil
end

--========================= State snapshot ====================================
local function buildState()
	local players = {}
	for _, plr in ipairs(Players:GetPlayers()) do
		local entry = {
			userId = plr.UserId,
			name = plr.Name,
			displayName = plr.DisplayName,
		}
		local char = plr.Character
		local hrp = char and char:FindFirstChild("HumanoidRootPart")
		local hum = char and char:FindFirstChildOfClass("Humanoid")
		if hrp then
			entry.position = vec3(hrp.Position)
			entry.velocity = vec3(hrp.AssemblyLinearVelocity)
		end
		if hum then
			entry.health = hum.Health
			entry.maxHealth = hum.MaxHealth
			entry.walkSpeed = hum.WalkSpeed
			entry.humanoidState = hum:GetState().Name
			local tool = char:FindFirstChildOfClass("Tool")
			if tool then
				entry.equippedTool = tool.Name
			end
		end
		local okPing, ping = pcall(function()
			return plr:GetNetworkPing() * 1000
		end)
		if okPing then
			entry.ping = ping
		end
		table.insert(players, entry)
	end

	-- Identity of whoever is running this bridge. Under an executor the script
	-- runs as a client, so Players.LocalPlayer is the executing user. On a real
	-- server there is no LocalPlayer and this stays nil.
	local executor = nil
	local localPlayer = Players.LocalPlayer
	if localPlayer then
		executor = {
			userId = localPlayer.UserId,
			name = localPlayer.Name,
			displayName = localPlayer.DisplayName,
		}
	end

	return {
		updatedAt = os.time() * 1000,
		gameTime = os.clock(),
		placeId = game.PlaceId,
		jobId = game.JobId,
		context = isExecutor and "executor" or (RunService:IsServer() and "server" or "client"),
		executor = executor,
		players = players,
		metrics = {
			playerCount = #players,
			workspaceChildren = #Workspace:GetChildren(),
			fps = math.floor(1 / math.max(RunService.Heartbeat:Wait(), 1e-6)),
		},
	}
end

local function pushState()
	local _, err = request("POST", "/state", buildState())
	if err then
		warnLog("state push failed:", err)
	end
end

--========================= Command dispatch ==================================
local commandHandlers = {}

commandHandlers.run_luau = function(args)
	local src = args.code
	if type(src) ~= "string" then
		error("code must be a string")
	end
	local fn, loadErr = loadstring("return (function() " .. src .. " end)()")
	if not fn then
		-- Try without implicit return wrapper for statement-only snippets.
		fn, loadErr = loadstring(src)
	end
	if not fn then
		error("loadstring failed (is LoadStringEnabled on?): " .. tostring(loadErr))
	end
	return fn()
end

commandHandlers.set_property = function(args)
	local node, err = resolvePath(args.path)
	if not node then
		error(err)
	end
	node[args.property] = coerceValue(args.value)
	return { path = args.path, property = args.property, ok = true }
end

commandHandlers.create_instance = function(args)
	local parent, err = resolvePath(args.parentPath)
	if not parent then
		error("parent " .. tostring(err))
	end
	local inst = Instance.new(args.className)
	for k, v in pairs(args.properties or {}) do
		pcall(function()
			inst[k] = coerceValue(v)
		end)
	end
	inst.Parent = parent
	return { created = inst:GetFullName() }
end

commandHandlers.destroy_instance = function(args)
	local node, err = resolvePath(args.path)
	if not node then
		error(err)
	end
	local name = node:GetFullName()
	node:Destroy()
	return { destroyed = name }
end

commandHandlers.fire_remote = function(args)
	local node, err = resolvePath(args.path)
	if not node then
		error(err)
	end
	local fargs = args.args or {}
	if node:IsA("RemoteEvent") then
		if args.toAll then
			node:FireAllClients(table.unpack(fargs))
		elseif args.userId then
			local plr = Players:GetPlayerByUserId(args.userId)
			if not plr then
				error("no player with userId " .. tostring(args.userId))
			end
			node:FireClient(plr, table.unpack(fargs))
		else
			error("specify toAll or userId for a RemoteEvent")
		end
		return { fired = true }
	elseif node:IsA("BindableEvent") then
		node:Fire(table.unpack(fargs))
		return { fired = true }
	else
		error("path is not a RemoteEvent/BindableEvent")
	end
end

commandHandlers.message = function(args)
	-- Relay to clients via the injected RemoteEvent if present, else log.
	local remote = ReplicatedStorage:FindFirstChild("MCPClientRemote")
	if remote and remote:IsA("RemoteEvent") then
		if args.userId then
			local plr = Players:GetPlayerByUserId(args.userId)
			if plr then
				remote:FireClient(plr, "message", { text = args.text })
			end
		else
			remote:FireAllClients("message", { text = args.text })
		end
	end
	print("[MCPBridge:message]", args.text)
	return { delivered = true }
end

commandHandlers.snapshot = function()
	pushState()
	return { ok = true }
end

local function executeCommand(cmd)
	local handler = commandHandlers[cmd.kind]
	local result = { id = cmd.id, finishedAt = os.time() * 1000 }
	if not handler then
		result.ok = false
		result.error = "unknown command kind: " .. tostring(cmd.kind)
		return result
	end
	local ok, ret = pcall(handler, cmd.args or {})
	result.ok = ok
	if ok then
		result.result = ret
	else
		result.error = tostring(ret)
	end
	return result
end

--========================= Capture: players & characters =====================
local function trackCharacter(plr, char)
	local hum = char:WaitForChild("Humanoid", 5)
	local hrp = char:WaitForChild("HumanoidRootPart", 5)
	if not hum then
		return
	end

	if CONFIG.CaptureJumps then
		hum.Jumping:Connect(function(active)
			if active then
				emit("jump", "Jumping", plr)
			end
		end)
	end

	if CONFIG.CaptureCharacter then
		hum.StateChanged:Connect(function(_, new)
			emit("character", "StateChanged", plr, { state = new.Name })
		end)
		hum.HealthChanged:Connect(function(health)
			emit("character", "HealthChanged", plr, { health = health, maxHealth = hum.MaxHealth })
		end)
		hum.Died:Connect(function()
			emit("character", "Died", plr)
		end)
	end

	if CONFIG.CaptureMovement and hrp then
		task.spawn(function()
			local last = hrp.Position
			while char.Parent and hum.Health > 0 do
				task.wait(CONFIG.MovementInterval)
				if not hrp.Parent then
					break
				end
				local pos = hrp.Position
				if (pos - last).Magnitude >= CONFIG.MovementThreshold then
					emit("movement", "Moved", plr, {
						position = vec3(pos),
						velocity = vec3(hrp.AssemblyLinearVelocity),
						speed = hrp.AssemblyLinearVelocity.Magnitude,
					})
					last = pos
				end
			end
		end)
	end

	emit("character", "Spawned", plr)
end

local function onToolAdded(plr, tool)
	if not CONFIG.CaptureTools or not tool:IsA("Tool") then
		return
	end
	tool.Equipped:Connect(function()
		emit("tool", "Equipped", plr, { tool = tool.Name })
	end)
	tool.Unequipped:Connect(function()
		emit("tool", "Unequipped", plr, { tool = tool.Name })
	end)
	tool.Activated:Connect(function()
		emit("tool", "Activated", plr, { tool = tool.Name })
	end)
end

local function trackPlayer(plr)
	emit("system", "PlayerAdded", plr)
	plr.CharacterAdded:Connect(function(char)
		trackCharacter(plr, char)
		char.ChildAdded:Connect(function(c)
			onToolAdded(plr, c)
		end)
	end)
	if plr.Character then
		trackCharacter(plr, plr.Character)
	end
	-- Tools live in the Backpack until equipped.
	local backpack = plr:FindFirstChildOfClass("Backpack")
	if backpack then
		backpack.ChildAdded:Connect(function(c)
			onToolAdded(plr, c)
		end)
		for _, c in ipairs(backpack:GetChildren()) do
			onToolAdded(plr, c)
		end
	end
end

Players.PlayerAdded:Connect(trackPlayer)
Players.PlayerRemoving:Connect(function(plr)
	emit("system", "PlayerRemoving", plr)
end)
for _, plr in ipairs(Players:GetPlayers()) do
	trackPlayer(plr)
end

--========================= Handler resolution (executor only) ================
-- Given a signal (e.g. ClickDetector.MouseClick or GuiButton.Activated), list
-- the script + line + function name of every connected handler. Needs the
-- executor global `getconnections`; safely returns {} otherwise. `selfSource`
-- is this bridge's own short_src so we can flag/skip our own capture handler.
local getconns = (typeof(getconnections) == "function" and getconnections)
	or (debug and rawget(debug, "getconnections"))
local selfSource = (function()
	local ok, s = pcall(function()
		return debug.info(1, "s")
	end)
	return ok and s or nil
end)()

local function resolveHandlers(signal)
	if not CONFIG.CaptureClickHandlers or not getconns then
		return nil
	end
	local out = {}
	local ok, conns = pcall(getconns, signal)
	if not ok or type(conns) ~= "table" then
		return nil
	end
	for _, c in ipairs(conns) do
		local fn = c.Function or c.Func or c["function"]
		if type(fn) == "function" then
			local iok, src, line, name = pcall(function()
				return debug.info(fn, "sln")
			end)
			if iok then
				table.insert(out, {
					script = src,
					line = line,
					name = (name ~= "" and name) or nil,
					isBridge = (src == selfSource) or nil,
					enabled = c.Enabled,
				})
			end
		end
	end
	return out
end

--========================= Capture: clicks (ClickDetector) ===================
local function hookClickDetector(cd)
	if not CONFIG.CaptureClicks or not cd:IsA("ClickDetector") then
		return
	end
	cd.MouseClick:Connect(function(plr)
		emit("click", "MouseClick", plr, {
			target = cd:GetFullName(),
			handlers = resolveHandlers(cd.MouseClick),
		})
	end)
end

--========================= Capture: remotes ==================================
local function hookRemote(inst)
	if not CONFIG.CaptureRemotes or not RunService:IsServer() then
		return
	end
	if inst:IsA("RemoteEvent") then
		pcall(function()
			inst.OnServerEvent:Connect(function(plr, ...)
				local n = select("#", ...)
				emit("remote", "OnServerEvent", plr, { remote = inst:GetFullName(), argCount = n })
			end)
		end)
	elseif inst:IsA("RemoteFunction") then
		-- Wrap OnServerInvoke without clobbering an existing handler if possible.
		pcall(function()
			local existing = inst.OnServerInvoke
			inst.OnServerInvoke = function(plr, ...)
				emit("remote", "OnServerInvoke", plr, { remote = inst:GetFullName() })
				if existing then
					return existing(plr, ...)
				end
			end
		end)
	end
end

--========================= Capture: objects/workspace ========================
local function emitObject(action, inst)
	if not CONFIG.CaptureObjects then
		return
	end
	emit("object", action, nil, {
		instance = inst:GetFullName(),
		className = inst.ClassName,
	})
end

for _, rootName in ipairs(CONFIG.WatchedRoots) do
	local ok, root = pcall(function()
		return game:GetService(rootName)
	end)
	root = (ok and root) or game:FindFirstChild(rootName)
	if root then
		root.DescendantAdded:Connect(function(inst)
			emitObject("Added", inst)
			hookClickDetector(inst)
		end)
		root.DescendantRemoving:Connect(function(inst)
			emitObject("Removing", inst)
		end)
		-- Hook ClickDetectors that already exist.
		for _, d in ipairs(root:GetDescendants()) do
			hookClickDetector(d)
		end
	end
end

-- Scan common containers for existing remotes and hook new ones.
for _, container in ipairs({ ReplicatedStorage, ServerStorage, Workspace }) do
	for _, d in ipairs(container:GetDescendants()) do
		hookRemote(d)
	end
	container.DescendantAdded:Connect(hookRemote)
end

--========================= Capture: output / logs ============================
-- LogService.MessageOut streams EVERY print/warn/error line produced by any
-- script in the place. This is the closest thing to "see what scripts are
-- doing" without a debugger.
local MESSAGE_TYPE = { [Enum.MessageType.MessageOutput] = "print", [Enum.MessageType.MessageInfo] = "info", [Enum.MessageType.MessageWarning] = "warning", [Enum.MessageType.MessageError] = "error" }
if CONFIG.CaptureLogs then
	LogService.MessageOut:Connect(function(message, msgType)
		-- Skip our own bridge chatter to avoid feedback loops.
		if string.sub(message, 1, 11) == "[MCPBridge]" or string.sub(message, 1, 12) == "[MCPBridge:" then
			return
		end
		if #message > CONFIG.MaxLogLength then
			message = string.sub(message, 1, CONFIG.MaxLogLength) .. "..."
		end
		emit("log", MESSAGE_TYPE[msgType] or tostring(msgType), nil, {
			message = message,
			severity = MESSAGE_TYPE[msgType] or "print",
		})
	end)
end

--========================= Capture: runtime errors ===========================
-- ScriptContext.Error fires for every unhandled error, giving the message, a
-- full stack traceback, and the Script instance that raised it.
if CONFIG.CaptureErrors then
	ScriptContext.Error:Connect(function(message, trace, scriptInstance)
		emit("error", "ScriptError", nil, {
			message = message,
			traceback = trace,
			script = scriptInstance and scriptInstance:GetFullName() or nil,
		})
	end)
end

--========================= Capture: chat =====================================
if CONFIG.CaptureChat then
	local function hookChat(plr)
		-- Legacy Chatted fires server-side for every player message.
		plr.Chatted:Connect(function(msg, recipient)
			emit("chat", "Chatted", plr, {
				message = msg,
				recipient = recipient and recipient.Name or nil,
			})
		end)
	end
	Players.PlayerAdded:Connect(hookChat)
	for _, plr in ipairs(Players:GetPlayers()) do
		hookChat(plr)
	end
end

--========================= Client collector (generated) ======================
-- Builds ONE LocalScript at runtime so GUI clicks and raw input are captured
-- without the developer installing a second file. The LocalScript reports back
-- through a RemoteEvent we create here.
local function setupClientCollector()
	if not CONFIG.InjectClientCollector then
		return
	end

	local remote = ReplicatedStorage:FindFirstChild("MCPClientRemote")
	if not remote then
		remote = Instance.new("RemoteEvent")
		remote.Name = "MCPClientRemote"
		remote.Parent = ReplicatedStorage
	end

	-- Server side: receive client-captured events and funnel into the buffer.
	remote.OnServerEvent:Connect(function(plr, kind, payload)
		payload = payload or {}
		if kind == "gui" then
			emit("gui", payload.action or "Activated", plr, payload)
		elseif kind == "click" then
			emit("click", payload.action or "Click", plr, payload)
		elseif kind == "input" then
			emit("click", payload.action or "Input", plr, payload)
		end
	end)

	local clientSource = [[
		local Players = game:GetService("Players")
		local UserInputService = game:GetService("UserInputService")
		local ReplicatedStorage = game:GetService("ReplicatedStorage")
		local remote = ReplicatedStorage:WaitForChild("MCPClientRemote")
		local plr = Players.LocalPlayer

		-- Raw mouse / touch / key input.
		UserInputService.InputBegan:Connect(function(input, processed)
			local t = input.UserInputType.Name
			remote:FireServer("input", {
				action = "InputBegan",
				inputType = t,
				keyCode = input.KeyCode.Name,
				processedByUI = processed,
			})
		end)

		-- Mouse world clicks.
		local mouse = plr:GetMouse()
		mouse.Button1Down:Connect(function()
			local tgt = mouse.Target
			remote:FireServer("click", {
				action = "WorldClick",
				target = tgt and tgt:GetFullName() or nil,
				position = tgt and { mouse.Hit.Position.X, mouse.Hit.Position.Y, mouse.Hit.Position.Z } or nil,
			})
		end)

		-- Executor-only: resolve which LocalScript(s)/line handle this signal.
		local getconns = (typeof(getconnections) == "function" and getconnections)
			or (debug and rawget(debug, "getconnections"))
		local function resolveHandlers(signal)
			if not getconns then
				return nil
			end
			local out = {}
			local ok, conns = pcall(getconns, signal)
			if not ok or type(conns) ~= "table" then
				return nil
			end
			for _, c in ipairs(conns) do
				local fn = c.Function or c.Func
				if type(fn) == "function" then
					local iok, src, line, name = pcall(function()
						return debug.info(fn, "sln")
					end)
					if iok then
						table.insert(out, { script = src, line = line, name = (name ~= "" and name) or nil })
					end
				end
			end
			return out
		end

		-- GUI button activations across all current and future ScreenGuis.
		local function hookButton(btn)
			if btn:IsA("GuiButton") then
				btn.Activated:Connect(function()
					remote:FireServer("gui", {
						action = "ButtonActivated",
						button = btn:GetFullName(),
						handlers = resolveHandlers(btn.Activated),
					})
				end)
			end
		end
		local pg = plr:WaitForChild("PlayerGui")
		pg.DescendantAdded:Connect(hookButton)
		for _, d in ipairs(pg:GetDescendants()) do
			hookButton(d)
		end

		-- Server -> client messages (notifications).
		remote.OnClientEvent:Connect(function(kind, data)
			if kind == "message" then
				print("[MCP message]", data and data.text)
			end
		end)
	]]

	-- Place a template LocalScript in StarterPlayerScripts so every player that
	-- joins gets a copy, and copy into existing players' PlayerGui too.
	local sps = StarterPlayer:FindFirstChild("StarterPlayerScripts")
	if sps and not sps:FindFirstChild("MCPClientCollector") then
		local ls = Instance.new("LocalScript")
		ls.Name = "MCPClientCollector"
		ls.Source = clientSource
		ls.Parent = sps
	end
	-- For players already in-game (script added at runtime), inject via PlayerGui.
	local function injectExisting(plr)
		local pg = plr:FindFirstChild("PlayerGui")
		if pg and not pg:FindFirstChild("MCPClientCollector") then
			local ls = Instance.new("LocalScript")
			ls.Name = "MCPClientCollector"
			ls.Source = clientSource
			ls.Parent = pg
		end
	end
	for _, plr in ipairs(Players:GetPlayers()) do
		injectExisting(plr)
	end
	Players.PlayerAdded:Connect(injectExisting)
end

-- IMPORTANT: Writing LocalScript.Source needs plugin-level security, so this
-- runtime injection only succeeds in privileged contexts. In a normal game it
-- safely no-ops (pcall-guarded) and GUI/raw-input capture is skipped while ALL
-- server-side capture keeps working. To guarantee GUI/input capture with a
-- single installed artifact, have your own client code fire the auto-created
-- ReplicatedStorage.MCPClientRemote — see the README "GUI & raw input" section.
pcall(setupClientCollector)

--========================= Main loops ========================================
local function safeSpawn(fn)
	task.spawn(function()
		while true do
			local ok, err = pcall(fn)
			if not ok then
				warnLog("loop error:", err)
				task.wait(1)
			end
		end
	end)
end

-- Flush events on a fixed cadence.
safeSpawn(function()
	flushEvents()
	task.wait(CONFIG.FlushInterval)
end)

-- Push state snapshots on a fixed cadence.
safeSpawn(function()
	pushState()
	task.wait(CONFIG.StateInterval)
end)

-- Command long-poll loop: block on GET /poll, run commands, report results.
safeSpawn(function()
	local data, err = request("GET", "/poll")
	if err then
		task.wait(1)
		return
	end
	local cmds = (data and data.commands) or {}
	if #cmds > 0 then
		local results = {}
		for _, cmd in ipairs(cmds) do
			table.insert(results, executeCommand(cmd))
		end
		request("POST", "/results", results)
	end
end)

-- Announce session start and confirm connectivity.
do
	local health, err = request("GET", "/health")
	if err then
		warnLog("could not reach bridge at " .. CONFIG.ApiUrl .. " — " .. err)
		warnLog("check Allow HTTP Requests, the URL, and that the Node MCP is running.")
	else
		log("connected to bridge:", HttpService:JSONEncode(health))
	end
end
emit("system", "BridgeStarted", nil, { placeId = game.PlaceId, jobId = game.JobId })
print("[MCPBridge] running. Streaming events to " .. CONFIG.ApiUrl)