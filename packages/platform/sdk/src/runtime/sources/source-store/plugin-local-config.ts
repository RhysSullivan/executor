import type {
  LocalConfigSource,
  Source,
} from "#schema";
import * as Schema from "effect/Schema";
import {
  cloneJson,
  configSourceBaseFromLocalSource,
} from "./config";

export const createPluginLocalConfigEntrySchema = <
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
    enabled: Schema.optional(Schema.Boolean),
    config: input.config,
    connection: Schema.optional(Schema.Unknown),
    binding: Schema.optional(Schema.Unknown),
  });

export const pluginLocalConfigSourceFromConfig = <TConfig>(input: {
  source: Source;
  config: TConfig;
}): LocalConfigSource => ({
  ...configSourceBaseFromLocalSource({
    source: input.source,
  }),
  kind: input.source.kind as LocalConfigSource["kind"],
  config: cloneJson(input.config),
});
