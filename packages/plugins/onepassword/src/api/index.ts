import { definePlugin } from "@executor-js/sdk/core";

import { onepasswordPlugin, type OnePasswordPluginOptions } from "../sdk/plugin";
import { OnePasswordGroup } from "./group";
import { OnePasswordHandlers, OnePasswordExtensionService } from "./handlers";

export { OnePasswordGroup } from "./group";
export { OnePasswordHandlers, OnePasswordExtensionService } from "./handlers";

// HTTP-augmented variant of `onepasswordPlugin`. The returned plugin
// carries the HTTP `routes`, `handlers`, and `extensionService` so a
// host can mount the 1Password HTTP surface. Hosts that compose an
// `HttpApi` should import this. SDK-only consumers stay on
// `@executor-js/plugin-onepassword` and never load `@executor-js/api`.
export const onepasswordHttpPlugin = definePlugin((options?: OnePasswordPluginOptions) => ({
  ...onepasswordPlugin(options),
  routes: () => OnePasswordGroup,
  handlers: () => OnePasswordHandlers,
  extensionService: OnePasswordExtensionService,
}));
