import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { evopaimoPlugin } from "./src/channel.js";

const entry: unknown = defineSetupPluginEntry(evopaimoPlugin);
export default entry;
