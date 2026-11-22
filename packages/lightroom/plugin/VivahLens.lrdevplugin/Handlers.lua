-- What the plugin does when the VivahLens agent asks: bring photos into the catalog, apply develop settings.
-- Every handler runs inside an async task, so catalog calls may yield; protect them with LrTasks.pcall, never plain pcall.

local LrApplication = import 'LrApplication'
local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'

local Json = require 'Json'

-- The name of the step each edit leaves in Lightroom's History panel: clicking the step before it undoes an edit.
local HISTORY_NAME = 'VivahLens AI edit'
local WRITE_TIMEOUT_SECONDS = 30
local IMPORT_CHUNK = 25

local protectedCall = LrTasks.pcall or pcall

local Handlers = { requests = {} }

local function fail(message)
  return { ok = false, error = message }
end

-- Only plain settings reach Lightroom: names made of letters and digits, values that are numbers, text or flags.
local function cleanSettings(raw)
  if type(raw) ~= 'table' then return nil, 'apply needs develop settings' end
  local clean, count = {}, 0
  for key, value in pairs(raw) do
    local kind = type(value)
    if type(key) ~= 'string' or not string.match(key, '^%a%w*$') then return nil, 'a setting has an unexpected name' end
    if kind ~= 'number' and kind ~= 'string' and kind ~= 'boolean' then
      return nil, 'setting ' .. key .. ' must be a number, text or a flag'
    end
    clean[key] = value
    count = count + 1
  end
  if count == 0 then return nil, 'there are no settings to apply' end
  return clean
end

local function firstLine(message)
  local line = string.match(tostring(message), '^[^\r\n]*')
  return (line ~= nil and line ~= '') and line or 'Lightroom refused the file'
end

local function activeCatalog()
  local catalog = LrApplication.activeCatalog()
  if not catalog then error('Lightroom has no catalog open', 0) end
  return catalog
end

function Handlers.requests.ping()
  return { ok = true }
end

function Handlers.requests.apply(message)
  if type(message.path) ~= 'string' or message.path == '' then return fail('apply needs the path of a photo') end
  local settings, problem = cleanSettings(message.settings)
  if not settings then return fail(problem) end

  local catalog = activeCatalog()
  local photo = catalog:findPhotoByPath(LrPathUtils.standardizePath(message.path), false)
  if not photo then return fail('the photo is not in the Lightroom catalog (import it first): ' .. message.path) end

  local outcome = catalog:withWriteAccessDo(HISTORY_NAME, function()
    photo:applyDevelopSettings(settings, HISTORY_NAME)
  end, { timeout = WRITE_TIMEOUT_SECONDS })
  if outcome == 'queued' then return fail('Lightroom could not open the catalog for writing in time; try again') end
  return { ok = true }
end

-- Adds files to the catalog in small batches, so Lightroom stays usable and the agent sees progress and can cancel.
-- Every path is answered: imported (or already there) or skipped with a reason.
function Handlers.requests.import(message, ctx)
  if type(message.paths) ~= 'table' then return fail('import needs a list of files') end
  local catalog = activeCatalog()
  local imported, skipped, pending = Json.array({}), Json.array({}), {}
  local total = 0

  for _, path in ipairs(message.paths) do
    if type(path) == 'string' then
      total = total + 1
      local native = LrPathUtils.standardizePath(path)
      if not LrFileUtils.exists(native) then
        skipped[#skipped + 1] = { path = path, reason = 'file not found' }
      elseif catalog:findPhotoByPath(native, false) then
        imported[#imported + 1] = path
      else
        pending[#pending + 1] = { path = path, native = native }
      end
    end
  end

  local nextIndex, cancelled = 1, false
  while nextIndex <= #pending and not cancelled do
    local first, last = nextIndex, math.min(nextIndex + IMPORT_CHUNK - 1, #pending)
    local outcome = catalog:withWriteAccessDo('VivahLens import', function()
      for i = first, last do
        local item = pending[i]
        local ok, err = protectedCall(function() return catalog:addPhoto(item.native) end)
        if ok then
          imported[#imported + 1] = item.path
        else
          skipped[#skipped + 1] = { path = item.path, reason = firstLine(err) }
        end
      end
    end, { timeout = WRITE_TIMEOUT_SECONDS })
    if outcome == 'queued' then
      for i = first, last do
        skipped[#skipped + 1] = { path = pending[i].path, reason = 'Lightroom could not open the catalog for writing in time' }
      end
    end
    nextIndex = last + 1
    cancelled = ctx.progress('import', #imported + #skipped, total)
  end

  for i = nextIndex, #pending do
    skipped[#skipped + 1] = { path = pending[i].path, reason = 'cancelled' }
  end
  return { ok = true, imported = imported, skipped = skipped }
end

return Handlers
