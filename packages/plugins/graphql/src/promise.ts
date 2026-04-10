import { graphqlPlugin as graphqlPluginEffect } from "./sdk/plugin";

export type { GraphqlSourceConfig } from "./sdk/plugin";
export type { HeaderValue } from "./sdk/types";
export type { GraphqlOperationStore } from "./sdk/operation-store";

export interface GraphqlPluginOptions {
  readonly operationStore?: import("./sdk/operation-store").GraphqlOperationStore;
}

export const graphqlPlugin = (options?: GraphqlPluginOptions) => graphqlPluginEffect(options);
