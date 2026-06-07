import { definePlugin } from "@executor-js/sdk";

import { graphqlPlugin, type GraphqlPluginOptions } from "../sdk/plugin";
import { GraphqlGroup } from "./group";
import { GraphqlHandlers, GraphqlExtensionService } from "./handlers";

export { GraphqlGroup } from "./group";
export { GraphqlHandlers, GraphqlExtensionService } from "./handlers";

// HTTP-augmented variant of `graphqlPlugin`. The returned plugin carries the
// HTTP `routes`, `handlers`, and `extensionService` so a host can mount the
// GraphQL HTTP surface. Hosts that compose an `HttpApi` import this; SDK-only
// consumers stay on `@executor-js/plugin-graphql-greenfield` and never load
// `@executor-js/api`.
export const graphqlHttpPlugin = definePlugin((options?: GraphqlPluginOptions) => ({
  ...graphqlPlugin(options),
  routes: () => GraphqlGroup,
  handlers: () => GraphqlHandlers,
  extensionService: GraphqlExtensionService,
}));
