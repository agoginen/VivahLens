-- A task started with a bare LrTasks.startAsyncTask here would be cancelled as soon as this script returns,
-- so the connection runs in a task that Lightroom ties to the plugin instead.
local LrFunctionContext = import 'LrFunctionContext'

local Bridge = require 'Bridge'

LrFunctionContext.postAsyncTaskWithContext('VivahLens connection', function()
  Bridge.run()
end)
