import { defineClientPlugin } from "@executor-js/sdk/client";

import { graphqlSourcePlugin } from "./source-plugin";

export default defineClientPlugin({
  id: "graphql" as const,
  sourcePlugin: graphqlSourcePlugin,
});
