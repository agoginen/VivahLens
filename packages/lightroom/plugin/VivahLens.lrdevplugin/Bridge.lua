-- The plugin's connection to the VivahLens agent on this computer.
--
-- Lightroom's SDK can make HTTP requests but not listen, so the plugin long-polls the agent's loopback server:
--   GET  /v1/next        a request to carry out (or nothing yet)
--   POST /v1/reply/<id>  the answer
--   POST /v1/progress    how far a long request has got; the reply names jobs the agent has cancelled
-- The agent writes its port and token to ~/.vivahlens/lightroom.json while it runs.

local LrApplication = import 'LrApplication'
local LrFileUtils = import 'LrFileUtils'
local LrHttp = import 'LrHttp'
local LrLogger = import 'LrLogger'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'

local Json = require 'Json'
local Handlers = require 'Handlers'

local PLUGIN = 'vivahlens-lrc'
local PLUGIN_VERSION = '1.0.0'
local PROTOCOL = 1

local log = LrLogger('VivahLens')
log:enable('logfile')

local protectedCall = LrTasks.pcall or pcall

local Bridge = {}

local settings = {
  pollWaitMs = 3000, -- how long the agent may hold a poll open
  httpTimeoutSeconds = 10, -- longer than the poll wait, so a held poll is not mistaken for a failure
  handshakePath = nil, -- tests point this elsewhere
}

local state = { running = false, stopRequested = false, connected = false, status = 'not started', handled = 0 }

function Bridge.defaultHandshakePath()
  local home = LrPathUtils.getStandardFilePath('home')
  return LrPathUtils.child(LrPathUtils.child(home, '.vivahlens'), 'lightroom.json')
end

-- The agent's port and token, or nil when the agent is not running or the file is not one we understand.
function Bridge.readHandshake(path)
  if not LrFileUtils.exists(path) then return nil end
  local text = LrFileUtils.readFile(path)
  if not text then return nil end
  local data = Json.decode(text)
  if type(data) ~= 'table' or data.protocol ~= PROTOCOL then return nil end
  if type(data.port) ~= 'number' or type(data.token) ~= 'string' or data.token == '' then return nil end
  return data
end

local function hostVersion()
  local ok, version = protectedCall(function() return LrApplication.versionTable() end)
  if ok and type(version) == 'table' and version.major then
    return string.format('%d.%d', version.major, version.minor or 0)
  end
  return nil
end

-- Returns the HTTP status (nil when the agent could not be reached) and the response body.
local function call(agent, method, route, body)
  local url = 'http://127.0.0.1:' .. string.format('%d', agent.port) .. route
  local headers = {
    { field = 'X-Vivah-Token', value = agent.token },
    { field = 'Content-Type', value = 'application/json' },
  }
  local text, meta
  if method == 'GET' then
    text, meta = LrHttp.get(url, headers, settings.httpTimeoutSeconds)
  else
    text, meta = LrHttp.post(url, body or '{}', headers, 'POST', settings.httpTimeoutSeconds)
  end
  local status = type(meta) == 'table' and tonumber(meta.status) or nil
  return status, text
end

local function listensTo(agent, jobId)
  return function(stage, done, total, text)
    local body = Json.encode({ stage = stage, done = done, total = total, jobId = jobId, message = text })
    local status, reply = call(agent, 'POST', '/v1/progress', body)
    if status ~= 200 or not jobId then return false end
    local decoded = Json.decode(reply)
    if type(decoded) ~= 'table' or type(decoded.cancelled) ~= 'table' then return false end
    for _, cancelledId in ipairs(decoded.cancelled) do
      if cancelledId == jobId then return true end
    end
    return false
  end
end

local function answer(agent, message)
  local handler = type(message.type) == 'string' and Handlers.requests[message.type] or nil
  if not handler then return { ok = false, error = 'unknown request type: ' .. tostring(message.type) } end
  local ok, result = protectedCall(handler, message, { progress = listensTo(agent, message.jobId) })
  if not ok then
    log:warn('request ' .. tostring(message.type) .. ' failed: ' .. tostring(result))
    return { ok = false, error = tostring(result) }
  end
  if type(result) ~= 'table' then return { ok = true } end
  if result.ok == nil then result.ok = true end
  return result
end

local function handle(agent, text)
  local message, problem = Json.decode(text)
  if type(message) ~= 'table' or type(message.id) ~= 'string' or not string.match(message.id, '^[%w%-]+$') then
    log:warn('ignored a request that is not understood: ' .. tostring(problem))
    return
  end
  local reply = answer(agent, message)
  local body, encodeProblem = Json.encode(reply)
  if not body then body = Json.encode({ ok = false, error = 'the plugin could not encode its answer: ' .. tostring(encodeProblem) }) end
  -- A 404 here means the agent gave up waiting (cancelled or timed out): there is nothing more to do.
  call(agent, 'POST', '/v1/reply/' .. message.id, body)
  state.handled = state.handled + 1
end

local function pollRoute(waitMs)
  local route = '/v1/next?wait=' .. string.format('%d', waitMs) .. '&plugin=' .. PLUGIN .. '&version=' .. PLUGIN_VERSION
  local host = hostVersion()
  if host then route = route .. '&host=' .. host end
  return route
end

local function setStatus(connected, text)
  state.connected = connected
  state.status = text
end

-- Runs until Bridge.stop(). Call it from an async task: it waits on HTTP.
function Bridge.run(overrides)
  if state.running then return end
  for key, value in pairs(overrides or {}) do settings[key] = value end
  state.running, state.stopRequested = true, false
  local agent, failures, introduced = nil, 0, false

  local function tick()
    if not agent then
      agent = Bridge.readHandshake(settings.handshakePath or Bridge.defaultHandshakePath())
      introduced = false
      if agent then
        setStatus(false, 'connecting to the VivahLens agent')
      else
        setStatus(false, 'waiting for the VivahLens agent (run "vivah edit --adapter lightroom")')
        LrTasks.sleep(2)
      end
      return
    end
    -- The first poll to a new agent returns at once, so it knows we are here and the status is true without a wait.
    local status, text = call(agent, 'GET', pollRoute(introduced and settings.pollWaitMs or 0))
    introduced = true
    if status == 200 and text then
      failures = 0
      setStatus(true, 'connected to the VivahLens agent')
      protectedCall(handle, agent, text)
    elseif status == 204 then
      failures = 0
      setStatus(true, 'connected to the VivahLens agent')
    elseif status == 401 or status == 403 then
      -- The agent restarted with a new token: read the handshake again.
      setStatus(false, 'the VivahLens agent did not accept this plugin; looking for a new handshake')
      agent = nil
      LrTasks.sleep(2)
    else
      failures = failures + 1
      setStatus(false, 'the VivahLens agent is not answering')
      if failures >= 2 then agent = nil end
      LrTasks.sleep(math.min(failures, 5))
    end
  end

  while not state.stopRequested do
    local ok, problem = protectedCall(tick)
    if not ok then
      log:warn('the connection loop hit an error: ' .. tostring(problem))
      agent = nil
      LrTasks.sleep(2)
    end
  end

  setStatus(false, 'stopped')
  state.running = false
end

function Bridge.stop()
  state.stopRequested = true
end

-- A sentence for the status dialog.
function Bridge.describe()
  local lines = { 'VivahLens plugin ' .. PLUGIN_VERSION, 'Status: ' .. state.status, 'Requests handled: ' .. string.format('%d', state.handled) }
  return table.concat(lines, '\n')
end

function Bridge.isConnected()
  return state.connected
end

return Bridge
