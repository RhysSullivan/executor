import { graphqlPlugin as graphqlPluginEffect } from "./sdk/plugin";

export type { GraphqlSourceConfig } from "./sdk/plugin";
export type { HeaderValue } from "./sdk/types";
export type { GraphqlOperationStore } from "./sdk/operation-store";

export type GraphqlPluginOptions = Record<string, never>;

export const graphqlPlugin = (_options?: GraphqlPluginOptions) => graphqlPluginEffect();
