// ---------------------------------------------------------------------------
// @executor-js/plugin-mcp/client — `defineClientPlugin` entry.
//
// Bakes `allowStdio: true` into the source plugin shipped via the
// virtual `plugins-client` module — that's the local-app default and
// the source plugin's UI options only matter when the server-side flag
// is also on. Hosts that want stdio off can keep importing
// `createMcpSourcePlugin({ allowStdio: false })` from `./react`
// directly and bypass the virtual module.
// ---------------------------------------------------------------------------

import { defineClientPlugin } from "@executor-js/sdk/client";

import { createMcpSourcePlugin } from "./source-plugin";

const mcpSourcePlugin = createMcpSourcePlugin({ allowStdio: true });

export default defineClientPlugin({
  id: "mcp" as const,
  sourcePlugin: mcpSourcePlugin,
});
