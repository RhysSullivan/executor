import type {
  ExecutorScopeConfigSource,
  Source,
} from "#schema";
import * as Schema from "effect/Schema";
import {
  cloneJson,
  scopeConfigSourceBaseFromSource,
} from "./config";

export const createPluginScopeConfigEntrySchema = <
  TKind extends string,
  TConfig,
>(
  input: {
    kind: TKind;
    config: Schema.Schema<TConfig, any, never>;
  },
) =>
  Schema.Struct({
    kind: Schema.Literal(input.kind),
    name: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    iconUrl: Schema.optional(Schema.String),
    enabled: Schema.optional(Schema.Boolean),
    config: input.config,
  });

export const pluginScopeConfigSourceFromConfig = <TConfig>(input: {
  source: Source;
  config: TConfig;
}): ExecutorScopeConfigSource => ({
  ...scopeConfigSourceBaseFromSource({
    source: input.source,
  }),
  kind: input.source.kind as ExecutorScopeConfigSource["kind"],
  config: cloneJson(input.config),
});
