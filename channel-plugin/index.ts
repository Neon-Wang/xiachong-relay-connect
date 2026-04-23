import {
  defineChannelPluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-core";
import { evopaimoPlugin } from "./src/channel.js";

/**
 * The shape returned by `defineChannelPluginEntry` is a private type inside
 * `openclaw/plugin-sdk/channel-core` and is not exported. We deliberately
 * type-erase the return value to `unknown` so TypeScript can emit a portable
 * `.d.ts` file. OpenClaw's plugin loader consults this default export at
 * runtime by calling `.register(api)`, so the runtime shape is guaranteed
 * by the SDK regardless of the declared TS type.
 */
const entry: unknown = defineChannelPluginEntry({
  id: "evopaimo",
  name: "EvoPaimo",
  description:
    "EvoPaimo desktop pet relay channel plugin. Connects to the Cloudflare Workers relay over WebSocket and dispatches client messages into the local OpenClaw agent runtime.",
  plugin: evopaimoPlugin,
  registerCliMetadata(api: OpenClawPluginApi) {
    api.registerCli(
      ({ program }) => {
        program
          .command("evopaimo")
          .description("EvoPaimo channel — status and diagnostic helpers");
      },
      {
        descriptors: [
          {
            name: "evopaimo",
            description: "EvoPaimo channel management",
            hasSubcommands: false,
          },
        ],
      },
    );
  },
  registerFull(api: OpenClawPluginApi) {
    // Runtime wiring lives in the ChannelPlugin's `gateway` adapter — see
    // `src/channel.ts`. OpenClaw calls our gateway.startAccount / stopAccount
    // hooks for every configured account as part of `openclaw gateway start`
    // and passes the account-scoped ChannelGatewayContext (incl.
    // channelRuntime) we need to connect the relay WebSocket and dispatch
    // replies through the agent runtime. Nothing further is needed here.
    void api;
  },
});

export default entry;
