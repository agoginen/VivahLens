return {
  LrSdkVersion = 13.0,
  LrSdkMinimumVersion = 10.0,

  LrToolkitIdentifier = 'com.vivahlens.lightroom',
  LrPluginName = 'VivahLens',

  LrInitPlugin = 'PluginInit.lua',
  LrShutdownPlugin = 'PluginShutdown.lua',
  -- Start the connection when Lightroom starts, not the first time the menu is opened.
  LrForceInitPlugin = true,

  LrLibraryMenuItems = {
    { title = 'VivahLens connection status', file = 'StatusDialog.lua' },
  },

  VERSION = { major = 1, minor = 0, revision = 0, build = 0 },
}
