import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { pinitPlugin } from "./src/channel.js";

const entry: unknown = defineSetupPluginEntry(pinitPlugin);
export default entry;
