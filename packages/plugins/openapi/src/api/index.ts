import { definePlugin } from "@executor-js/sdk/core";

import { openApiPlugin, type OpenApiPluginOptions } from "../sdk/plugin";
import { OpenApiGroup } from "./group";
import { OpenApiHandlers, OpenApiExtensionService } from "./handlers";

export { OpenApiGroup } from "./group";
export { OpenApiHandlers, OpenApiExtensionService } from "./handlers";

// HTTP-augmented variant of `openApiPlugin`. The returned plugin
// carries the HTTP `routes`, `handlers`, and `extensionService` so a
// host can mount the OpenAPI HTTP surface. Hosts that compose an
// `HttpApi` should import this. SDK-only consumers stay on
// `@executor-js/plugin-openapi` and never load `@executor-js/api`.
export const openApiHttpPlugin = definePlugin((options?: OpenApiPluginOptions) => ({
  ...openApiPlugin(options),
  routes: () => OpenApiGroup,
  handlers: () => OpenApiHandlers,
  extensionService: OpenApiExtensionService,
}));
