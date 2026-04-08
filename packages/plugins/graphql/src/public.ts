import type { Plugin } from "@executor/sdk";
import {
  graphqlPlugin as _graphqlPlugin,
  type GraphqlSourceConfig,
} from "./sdk/plugin";

export type { GraphqlSourceConfig } from "./sdk/plugin";
export type { HeaderValue } from "./sdk/types";

export interface GraphqlExtension {
  readonly addSource: (
    config: GraphqlSourceConfig,
  ) => Promise<{ readonly toolCount: number }>;
  readonly removeSource: (namespace: string) => Promise<void>;
}

export const graphqlPlugin: (
  options?: {},
) => Plugin<"graphql", GraphqlExtension> = _graphqlPlugin as any;
