import {
  Schema,
} from "effect";

export const ExecutorRuntimeConfigSchema = Schema.Literal(
  "quickjs",
  "ses",
  "deno",
);

const ExecutorScopeConfigSourceBaseSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  iconUrl: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  config: Schema.optional(Schema.Unknown),
});

export const ExecutorScopeConfigSourceSchema = Schema.extend(
  ExecutorScopeConfigSourceBaseSchema,
  Schema.Struct({
    kind: Schema.String,
  }),
);

export type ExecutorScopeConfigSource = typeof ExecutorScopeConfigSourceSchema.Type;

export const ExecutorScopeConfigPolicyActionSchema = Schema.Literal("allow", "deny");
export const ExecutorScopeConfigPolicyApprovalSchema = Schema.Literal(
  "auto",
  "manual",
);

export const ExecutorScopeConfigPolicySchema = Schema.Struct({
  match: Schema.String,
  action: ExecutorScopeConfigPolicyActionSchema,
  approval: ExecutorScopeConfigPolicyApprovalSchema,
  enabled: Schema.optional(Schema.Boolean),
  priority: Schema.optional(Schema.Number),
});

export const ExecutorScopeWorkspaceConfigSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
});

export const ExecutorScopeConfigSchema = Schema.Struct({
  runtime: Schema.optional(ExecutorRuntimeConfigSchema),
  workspace: Schema.optional(ExecutorScopeWorkspaceConfigSchema),
  sources: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: ExecutorScopeConfigSourceSchema,
    }),
  ),
  policies: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: ExecutorScopeConfigPolicySchema,
    }),
  ),
});

export type ExecutorScopeConfigPolicy =
  typeof ExecutorScopeConfigPolicySchema.Type;
export type ExecutorRuntimeConfig = typeof ExecutorRuntimeConfigSchema.Type;
export type ExecutorScopeConfig = typeof ExecutorScopeConfigSchema.Type;
