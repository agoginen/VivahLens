local LrDialogs = import 'LrDialogs'
local LrTasks = import 'LrTasks'

local Bridge = require 'Bridge'

LrTasks.startAsyncTask(function()
  LrDialogs.message('VivahLens', Bridge.describe(), Bridge.isConnected() and 'info' or 'warning')
end)
