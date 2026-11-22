import { PluginBridge, type PluginBridgeOptions } from "@vivahlens/core";

/** Where the agent leaves the port and token for the plugin, inside the VivahLens data folder. The plugin looks for this file name. */
export const LIGHTROOM_HANDSHAKE_FILE = "lightroom.json";

/** The agent's end of the connection to the VivahLens plugin in Lightroom Classic; the protocol is documented on `PluginBridge`. */
export class LightroomBridge extends PluginBridge {
  constructor(opts: PluginBridgeOptions = {}) {
    super({ name: "Lightroom plugin", ...opts });
  }
}
