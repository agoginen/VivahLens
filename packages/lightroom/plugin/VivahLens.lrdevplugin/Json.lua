-- JSON for the VivahLens plugin. Lightroom's SDK ships no JSON module, so this is our own.
-- Written for Lua 5.1 (what Lightroom Classic embeds): no goto, no integer division, no bit operators.

local Json = {}

local MAX_DEPTH = 100

-- Decoded `null`. A table, so an array can hold it without a hole.
local NULL = setmetatable({}, { __tostring = function() return 'null' end })
Json.null = NULL

-- Marks a table as a JSON array even when it is empty (a plain empty table encodes as {}).
local arrayMeta = {}

function Json.array(items)
  return setmetatable(items or {}, arrayMeta)
end

local ESCAPES = {
  ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function quote(text)
  text = string.gsub(text, '[\\"]', function(c) return '\\' .. c end)
  text = string.gsub(text, '[\1-\31\127]', function(c)
    return ESCAPES[c] or string.format('\\u%04x', string.byte(c))
  end)
  text = string.gsub(text, '%z', '\\u0000')
  return '"' .. text .. '"'
end

local function encodeNumber(n)
  if n ~= n or n == math.huge or n == -math.huge then return 'null' end
  local text = string.format('%.14g', n)
  if tonumber(text) ~= n then text = string.format('%.17g', n) end
  -- A locale with a decimal comma would otherwise produce invalid JSON.
  return (string.gsub(text, ',', '.'))
end

local function isArray(t)
  if getmetatable(t) == arrayMeta then return true end
  if next(t) == nil then return false end
  local count = 0
  for _ in pairs(t) do count = count + 1 end
  return count == #t
end

local encodeValue

local function encodeTable(t, depth)
  if depth > MAX_DEPTH then error('JSON nesting is too deep', 0) end
  local parts = {}
  if isArray(t) then
    for i = 1, #t do parts[i] = encodeValue(t[i], depth + 1) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local keys = {}
  for key in pairs(t) do
    if type(key) ~= 'string' then error('a JSON object needs string keys', 0) end
    keys[#keys + 1] = key
  end
  table.sort(keys)
  for i, key in ipairs(keys) do parts[i] = quote(key) .. ':' .. encodeValue(t[key], depth + 1) end
  return '{' .. table.concat(parts, ',') .. '}'
end

encodeValue = function(value, depth)
  local kind = type(value)
  if value == nil or value == NULL then return 'null' end
  if kind == 'boolean' then return value and 'true' or 'false' end
  if kind == 'number' then return encodeNumber(value) end
  if kind == 'string' then return quote(value) end
  if kind == 'table' then return encodeTable(value, depth) end
  error('cannot encode a ' .. kind .. ' as JSON', 0)
end

-- Returns the JSON text, or nil and a message when the value cannot be encoded.
function Json.encode(value)
  local ok, result = pcall(encodeValue, value, 1)
  if ok then return result end
  return nil, tostring(result)
end

local function utf8Char(cp)
  if cp < 0x80 then return string.char(cp) end
  if cp < 0x800 then
    return string.char(0xC0 + math.floor(cp / 0x40), 0x80 + cp % 0x40)
  end
  if cp < 0x10000 then
    return string.char(0xE0 + math.floor(cp / 0x1000), 0x80 + math.floor(cp / 0x40) % 0x40, 0x80 + cp % 0x40)
  end
  return string.char(
    0xF0 + math.floor(cp / 0x40000),
    0x80 + math.floor(cp / 0x1000) % 0x40,
    0x80 + math.floor(cp / 0x40) % 0x40,
    0x80 + cp % 0x40
  )
end

local UNESCAPES = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }

local function fail(text, pos, message)
  error(message .. ' at position ' .. pos, 0)
end

local function skipSpace(text, pos)
  local _, last = string.find(text, '^[ \t\r\n]*', pos)
  return last + 1
end

local function hex4(text, pos)
  local digits = string.match(text, '^%x%x%x%x', pos)
  if not digits then fail(text, pos, 'bad \\u escape') end
  return tonumber(digits, 16)
end

local function parseString(text, pos)
  -- pos is just past the opening quote
  local out = {}
  while true do
    local stop = string.find(text, '["\\]', pos)
    if not stop then fail(text, pos, 'unterminated string') end
    out[#out + 1] = string.sub(text, pos, stop - 1)
    if string.sub(text, stop, stop) == '"' then return table.concat(out), stop + 1 end
    local escape = string.sub(text, stop + 1, stop + 1)
    if escape == 'u' then
      local cp = hex4(text, stop + 2)
      pos = stop + 6
      if cp >= 0xD800 and cp <= 0xDBFF then
        local low = string.match(text, '^\\u(%x%x%x%x)', pos)
        local lowValue = low and tonumber(low, 16)
        if lowValue and lowValue >= 0xDC00 and lowValue <= 0xDFFF then
          cp = 0x10000 + (cp - 0xD800) * 0x400 + (lowValue - 0xDC00)
          pos = pos + 6
        else
          cp = 0xFFFD
        end
      elseif cp >= 0xDC00 and cp <= 0xDFFF then
        cp = 0xFFFD
      end
      out[#out + 1] = utf8Char(cp)
    else
      local plain = UNESCAPES[escape]
      if not plain then fail(text, stop, 'bad escape') end
      out[#out + 1] = plain
      pos = stop + 2
    end
  end
end

local function parseNumber(text, pos)
  local int = string.match(text, '^-?%d+', pos)
  if not int then fail(text, pos, 'unexpected character') end
  local last = pos + #int
  local fraction = string.match(text, '^%.%d+', last)
  if fraction then last = last + #fraction end
  local exponent = string.match(text, '^[eE][+-]?%d+', last)
  if exponent then last = last + #exponent end
  local literal = string.sub(text, pos, last - 1)
  local value = tonumber(literal)
  if value == nil then value = tonumber((string.gsub(literal, '%.', ','))) end
  if value == nil then fail(text, pos, 'bad number') end
  return value, last
end

local parseValue

local function parseObject(text, pos, depth)
  local result = {}
  pos = skipSpace(text, pos)
  if string.sub(text, pos, pos) == '}' then return result, pos + 1 end
  while true do
    pos = skipSpace(text, pos)
    if string.sub(text, pos, pos) ~= '"' then fail(text, pos, 'expected a string key') end
    local key
    key, pos = parseString(text, pos + 1)
    pos = skipSpace(text, pos)
    if string.sub(text, pos, pos) ~= ':' then fail(text, pos, 'expected ":"') end
    result[key], pos = parseValue(text, pos + 1, depth + 1)
    pos = skipSpace(text, pos)
    local mark = string.sub(text, pos, pos)
    if mark == '}' then return result, pos + 1 end
    if mark ~= ',' then fail(text, pos, 'expected "," or "}"') end
    pos = pos + 1
  end
end

local function parseArray(text, pos, depth)
  local result = Json.array({})
  pos = skipSpace(text, pos)
  if string.sub(text, pos, pos) == ']' then return result, pos + 1 end
  while true do
    result[#result + 1], pos = parseValue(text, pos, depth + 1)
    pos = skipSpace(text, pos)
    local mark = string.sub(text, pos, pos)
    if mark == ']' then return result, pos + 1 end
    if mark ~= ',' then fail(text, pos, 'expected "," or "]"') end
    pos = pos + 1
  end
end

parseValue = function(text, pos, depth)
  if depth > MAX_DEPTH then fail(text, pos, 'nesting is too deep') end
  pos = skipSpace(text, pos)
  local c = string.sub(text, pos, pos)
  if c == '{' then return parseObject(text, pos + 1, depth) end
  if c == '[' then return parseArray(text, pos + 1, depth) end
  if c == '"' then return parseString(text, pos + 1) end
  if string.sub(text, pos, pos + 3) == 'true' then return true, pos + 4 end
  if string.sub(text, pos, pos + 4) == 'false' then return false, pos + 5 end
  if string.sub(text, pos, pos + 3) == 'null' then return NULL, pos + 4 end
  return parseNumber(text, pos)
end

-- Returns the value, or nil and a message when the text is not valid JSON. `null` decodes to Json.null.
function Json.decode(text)
  if type(text) ~= 'string' then return nil, 'expected text' end
  local ok, value, pos = pcall(parseValue, text, 1, 1)
  if not ok then return nil, tostring(value) end
  pos = skipSpace(text, pos)
  if pos <= #text then return nil, 'unexpected text after the value at position ' .. pos end
  return value
end

return Json
