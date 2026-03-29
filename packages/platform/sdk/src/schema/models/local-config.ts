import {
  Schema,
} from "effect";

export const LocalExecutorRuntimeSchema = Schema.Literal(
  "quickjs",
  "ses",
  "deno",
);

export const LocalConfigSourceConnectionSchema = Schema.Struct({
  endpoint: Schema.optional(Schema.NullOr(Schema.String)),
  auth: Schema.optional(Schema.Unknown),
});

const LocalConfigSourceEntryBaseSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  config: Schema.optional(Schema.Unknown),
  connection: Schema.optional(LocalConfigSourceConnectionSchema),
  binding: Schema.optional(Schema.Unknown),
});

export const LocalConfigSourceSchema = Schema.extend(
  LocalConfigSourceEntryBaseSchema,
  Schema.Struct({
    kind: Schema.String,
  }),
);

export type LocalConfigSource = typeof LocalConfigSourceSchema.Type;

export const LocalConfigPolicyActionSchema = Schema.Literal("allow", "deny");
export const LocalConfigPolicyApprovalSchema = Schema.Literal("auto", "manual");

export const LocalConfigPolicySchema = Schema.Struct({
  match: Schema.String,
  action: LocalConfigPolicyActionSchema,
  approval: LocalConfigPolicyApprovalSchema,
  enabled: Schema.optional(Schema.Boolean),
  priority: Schema.optional(Schema.Number),
});

export const LocalConfigWorkspaceSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
});

export const LocalExecutorConfigSchema = Schema.Struct({
  runtime: Schema.optional(LocalExecutorRuntimeSchema),
  workspace: Schema.optional(LocalConfigWorkspaceSchema),
  sources: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: LocalConfigSourceSchema,
    }),
  ),
  policies: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: LocalConfigPolicySchema,
    }),
  ),
});

export type LocalConfigPolicy = typeof LocalConfigPolicySchema.Type;
export type LocalExecutorRuntime = typeof LocalExecutorRuntimeSchema.Type;
export type LocalExecutorConfig = typeof LocalExecutorConfigSchema.Type;
