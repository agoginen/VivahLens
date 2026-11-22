-- A stand-in for the parts of the Lightroom Classic SDK that the VivahLens plugin uses, for running the plugin's real
-- Lua code under test. It is deliberately stricter than the plain environment in two ways that matter to plugin authors:
--   * Lua 5.1 only: the 5.2+ library functions the plugin must not rely on are removed, and
--   * a plain pcall cannot be yielded across (LrTasks.pcall can), as in Lightroom's Lua 5.1.
-- Run by test/luaHost.ts, which provides __host (timers, HTTP, plugin source files).

local host = __host

local realPcall, realXpcall = pcall, xpcall
local realUnpack = table.unpack
local guardDepth = 0

local function leave(...)
  guardDepth = guardDepth - 1
  return ...
end

function pcall(f, ...)
  guardDepth = guardDepth + 1
  return leave(realPcall(f, ...))
end

function xpcall(f, handler, ...)
  guardDepth = guardDepth + 1
  return leave(realXpcall(f, handler, ...))
end

unpack = realUnpack
loadstring = load
table.getn = function(t) return #t end
table.unpack, table.pack, table.move = nil, nil, nil
string.pack, string.unpack, string.packsize = nil, nil, nil
math.type, math.tointeger, math.ult = nil, nil, nil
utf8, bit32, rawlen = nil, nil, nil

local function copy(value)
  if type(value) ~= 'table' then return value end
  local out = {}
  for k, v in pairs(value) do out[k] = copy(v) end
  return out
end

__mock = {
  sep = '\\',
  home = 'C:\\Users\\tester',
  version = { major = 15, minor = 1, revision = 0, build = 0 },
  files = {}, -- lower-cased native path → true
  contents = {}, -- lower-cased native path → text
  photos = {}, -- lower-cased native path → { path, develop }
  rejects = {}, -- lower-cased native path → the error addPhoto raises for it
  busy = false, -- write access cannot be had in time
  noCatalog = false,
  history = {}, -- every applyDevelopSettings: { path, name, settings }
  writes = {}, -- every write-access block: its name
  dialogs = {},
  logs = {},
}

local mock = __mock

local function key(path)
  return string.lower((string.gsub(path, '[/\\]', mock.sep)))
end

function mock.addFile(path, text)
  mock.files[key(path)] = true
  if text then mock.contents[key(path)] = text end
end

function mock.removeFile(path)
  mock.files[key(path)] = nil
  mock.contents[key(path)] = nil
end

function mock.catalogHas(path)
  return mock.photos[key(path)] ~= nil
end

function mock.addToCatalog(path)
  mock.addFile(path)
  mock.photos[key(path)] = { path = path, develop = { Exposure2012 = 0 } }
end

local inWrite = false

local function inTask(what)
  local _, isMain = coroutine.running()
  if isMain then error(what .. ' must be called from an async task', 3) end
  if guardDepth > 0 then
    error(what .. ': attempt to yield across a C-call boundary (Lightroom needs LrTasks.pcall here)', 3)
  end
end

local function needsWriteAccess(what)
  if not inWrite then error(what .. ' must be called from within catalog:withWriteAccessDo', 3) end
end

local modules = {}

function import(name)
  local module = modules[name]
  if not module then error("import: there is no Lightroom module '" .. tostring(name) .. "'", 2) end
  return module
end

-- Tasks: each runs as a coroutine; waiting on a timer or HTTP yields to the host, which resumes it later.
local LrTasks = {}
modules.LrTasks = LrTasks

local function startTask(fn, ...)
  local co = coroutine.create(fn)
  local function step(...)
    local ok, request = coroutine.resume(co, ...)
    if not ok then
      host.taskFailed(tostring(request))
      return
    end
    if coroutine.status(co) == 'dead' then return end
    if request.op == 'sleep' then
      host.sleep(request.seconds, step)
    elseif request.op == 'http' then
      host.http(request.method, request.url, request.headers, request.body, request.timeout, step)
    else
      host.taskFailed('a task yielded something unexpected: ' .. tostring(request.op))
    end
  end
  step(...)
end

function LrTasks.startAsyncTask(fn)
  startTask(fn)
end

function LrTasks.sleep(seconds)
  inTask('LrTasks.sleep')
  coroutine.yield({ op = 'sleep', seconds = seconds })
end

LrTasks.pcall = realPcall

local LrFunctionContext = {}
modules.LrFunctionContext = LrFunctionContext

function LrFunctionContext.postAsyncTaskWithContext(name, fn)
  assert(type(name) == 'string', 'a task needs a name')
  startTask(function()
    local cleanups = {}
    local context = { addCleanupHandler = function(_, handler) cleanups[#cleanups + 1] = handler end }
    local ok, problem = realPcall(fn, context)
    for _, handler in ipairs(cleanups) do handler() end
    if not ok then error(problem, 0) end
  end)
end

local LrHttp = {}
modules.LrHttp = LrHttp

local function request(method, url, headers, body, timeout)
  inTask('LrHttp.' .. string.lower(method))
  assert(type(url) == 'string', 'the url must be a string')
  assert(type(timeout) == 'number', 'the timeout must be a number of seconds')
  local lines = {}
  for _, header in ipairs(headers or {}) do
    assert(type(header.field) == 'string' and type(header.value) == 'string', 'a header is {field=, value=}')
    lines[#lines + 1] = header.field .. ': ' .. header.value
  end
  local status, text, problem = coroutine.yield({
    op = 'http', method = method, url = url, headers = table.concat(lines, '\n'), body = body, timeout = timeout,
  })
  if not status then return nil, { error = { errorCode = 'cannotConnectToHost', name = problem or 'could not connect' } } end
  return text, { status = status }
end

function LrHttp.get(url, headers, timeout)
  return request('GET', url, headers, nil, timeout)
end

function LrHttp.post(url, body, headers, method, timeout)
  assert(type(body) == 'string', 'the body must be a string')
  return request(method or 'POST', url, headers, body, timeout)
end

local LrPathUtils = {}
modules.LrPathUtils = LrPathUtils

function LrPathUtils.getStandardFilePath(which)
  if which == 'home' then return mock.home end
  error("getStandardFilePath: unexpected name '" .. tostring(which) .. "'", 2)
end

function LrPathUtils.child(parent, name)
  return parent .. mock.sep .. name
end

function LrPathUtils.standardizePath(path)
  return (string.gsub(path, '[/\\]', mock.sep))
end

local LrFileUtils = {}
modules.LrFileUtils = LrFileUtils

function LrFileUtils.exists(path)
  return mock.files[key(path)] and 'file' or false
end

function LrFileUtils.readFile(path)
  return mock.contents[key(path)]
end

local LrLogger = setmetatable({}, {
  __call = function()
    local logger = {}
    function logger:enable() end
    for _, level in ipairs({ 'trace', 'debug', 'info', 'warn', 'error', 'fatal' }) do
      logger[level] = function(_, text) mock.logs[#mock.logs + 1] = level .. ': ' .. tostring(text) end
    end
    return logger
  end,
})
modules.LrLogger = LrLogger

local LrDialogs = {}
modules.LrDialogs = LrDialogs

function LrDialogs.message(title, message, style)
  mock.dialogs[#mock.dialogs + 1] = { title = title, message = message, style = style }
end

local Photo = {}
Photo.__index = Photo

function Photo:applyDevelopSettings(settings, name)
  needsWriteAccess('photo:applyDevelopSettings')
  assert(type(settings) == 'table', 'settings must be a table')
  assert(type(name) == 'string', 'the history name must be a string')
  for k, v in pairs(settings) do
    local kind = type(v)
    assert(type(k) == 'string' and (kind == 'number' or kind == 'string' or kind == 'boolean'), 'unusable setting ' .. tostring(k))
    self.develop[k] = v
  end
  mock.history[#mock.history + 1] = { path = self.path, name = name, settings = copy(settings) }
end

function Photo:getDevelopSettings()
  return copy(self.develop)
end

local Catalog = {}
Catalog.__index = Catalog

function Catalog:withWriteAccessDo(name, fn, timeoutParams)
  inTask('catalog:withWriteAccessDo')
  assert(type(name) == 'string' and type(fn) == 'function', 'withWriteAccessDo(name, function, timeout)')
  assert(timeoutParams == nil or type(timeoutParams) == 'table', 'the timeout parameters are a table')
  if mock.busy then return 'queued' end
  if inWrite then error('write access is already open', 2) end
  inWrite = true
  mock.writes[#mock.writes + 1] = name
  local ok, problem = realPcall(fn, {})
  inWrite = false
  if not ok then error(problem, 0) end
  return 'executed'
end

function Catalog:findPhotoByPath(path, caseSensitive)
  assert(type(path) == 'string', 'findPhotoByPath needs a path')
  local entry = mock.photos[key(path)]
  if not entry then return nil end
  if caseSensitive == true and entry.path ~= path then return nil end
  return setmetatable(entry, Photo)
end

function Catalog:addPhoto(path)
  needsWriteAccess('catalog:addPhoto')
  assert(type(path) == 'string', 'addPhoto needs a path')
  if not mock.files[key(path)] then error('The file ' .. path .. ' does not exist.', 2) end
  local refused = mock.rejects[key(path)]
  if refused then error(refused, 2) end
  local entry = mock.photos[key(path)] or { path = path, develop = { Exposure2012 = 0 } }
  mock.photos[key(path)] = entry
  return setmetatable(entry, Photo)
end

local LrApplication = {}
modules.LrApplication = LrApplication

function LrApplication.activeCatalog()
  if mock.noCatalog then return nil end
  return setmetatable({}, Catalog)
end

function LrApplication.versionTable()
  return copy(mock.version)
end

-- Plugin files are modules for require, and chunks to run for Lightroom's own entry points.
table.insert(package.searchers, 2, function(name)
  local source = host.source(name)
  if not source then return "\n\tno plugin file '" .. name .. ".lua'" end
  local chunk, problem = load(source, '@' .. name .. '.lua')
  if not chunk then error(problem, 0) end
  return chunk, name
end)

function __runPluginFile(name)
  local source = host.source(name)
  if not source then error('the plugin has no file ' .. name .. '.lua', 0) end
  local chunk, problem = load(source, '@' .. name .. '.lua')
  if not chunk then error(problem, 0) end
  return chunk()
end

-- What the tests look at, as JSON written by the plugin's own encoder.
function mock.report()
  local Json = require 'Json'
  local photos = {}
  for _, entry in pairs(mock.photos) do photos[entry.path] = entry.develop end
  return Json.encode({
    photos = photos,
    history = Json.array(mock.history),
    writes = Json.array(mock.writes),
    dialogs = Json.array(mock.dialogs),
    logs = Json.array(mock.logs),
  })
end
