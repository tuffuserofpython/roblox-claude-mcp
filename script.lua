--[[
	Jump loop — makes a player jump continuously.

	Run on the SERVER (ServerScriptService) or via the MCP's roblox_run_luau.
	Set TARGET_USER_ID to the player that should jump.

	The Humanoid.Jumping event fires normally, so MCPBridge captures each jump
	as a "jump" event (exactly like a manual jump).

	To STOP: set _G.MCPJumpLoop to any other value, e.g.:
		_G.MCPJumpLoop = -1
]]

local TARGET_USER_ID = 3596137039 -- viniciuw3458 (tuffo)
local JUMP_INTERVAL = 0.6 -- seconds between each jump

local Players = game:GetService("Players")

local plr = Players:GetPlayerByUserId(TARGET_USER_ID)
if not plr then
	warn("[JumpLoop] player not found: " .. TARGET_USER_ID)
	return
end

-- Token: invalidates any previous loop and prevents two from running at once.
_G.MCPJumpLoop = (_G.MCPJumpLoop or 0) + 1
local myToken = _G.MCPJumpLoop

task.spawn(function()
	while _G.MCPJumpLoop == myToken do
		local char = plr.Character
		local hum = char and char:FindFirstChildOfClass("Humanoid")
		if hum and hum.Health > 0 then
			hum.Jump = true
		end
		task.wait(JUMP_INTERVAL)
	end
end)

print("[JumpLoop] started for " .. plr.Name .. " (token " .. myToken .. ")")
