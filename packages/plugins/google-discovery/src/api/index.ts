import { definePlugin } from "@executor-js/sdk/core";

import { googleDiscoveryPlugin } from "../sdk/plugin";
import { GoogleDiscoveryGroup } from "./group";
import { GoogleDiscoveryExtensionService, GoogleDiscoveryHandlers } from "./handlers";

export { GoogleDiscoveryGroup } from "./group";
export { GoogleDiscoveryExtensionService, GoogleDiscoveryHandlers } from "./handlers";

// HTTP-augmented variant of `googleDiscoveryPlugin`. The returned
// plugin carries the HTTP `routes`, `handlers`, and `extensionService`
// so a host can mount the Google Discovery HTTP surface. Hosts that
// compose an `HttpApi` should import this. SDK-only consumers stay on
// `@executor-js/plugin-google-discovery` and never load
// `@executor-js/api`.
export const googleDiscoveryHttpPlugin = definePlugin(
  (options?: Parameters<typeof googleDiscoveryPlugin>[0]) => ({
    ...googleDiscoveryPlugin(options),
    routes: () => GoogleDiscoveryGroup,
    handlers: () => GoogleDiscoveryHandlers,
    extensionService: GoogleDiscoveryExtensionService,
  }),
);
