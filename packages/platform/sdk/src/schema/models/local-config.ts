import {
  Schema,
} from "effect";

export const LocalExecutorRuntimeSchema = Schema.Literal(
  "quickjs",
  "ses",
  "deno",
);

export const LocalConfigSecretProviderSourceSchema = Schema.Literal(
  "env",
  "file",
  "exec",
  "params",
);

export const LocalConfigEnvSecretProviderSchema = Schema.Struct({
  source: Schema.Literal("env"),
});

export const LocalConfigFileSecretProviderModeSchema = Schema.Literal(
  "singleValue",
  "json",
);

export const LocalConfigFileSecretProviderSchema = Schema.Struct({
  source: Schema.Literal("file"),
  path: Schema.String,
  mode: Schema.optional(LocalConfigFileSecretProviderModeSchema),
});

export const LocalConfigExecSecretProviderSchema = Schema.Struct({
  source: Schema.Literal("exec"),
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  allowSymlinkCommand: Schema.optional(Schema.Boolean),
  trustedDirs: Schema.optional(Schema.Array(Schema.String)),
});

export const LocalConfigSecretProviderSchema = Schema.Union(
  LocalConfigEnvSecretProviderSchema,
  LocalConfigFileSecretProviderSchema,
  LocalConfigExecSecretProviderSchema,
);

export const LocalConfigExplicitSecretRefSchema = Schema.Struct({
  source: LocalConfigSecretProviderSourceSchema,
  provider: Schema.String,
  id: Schema.String,
});

export const LocalConfigSecretInputSchema = Schema.Union(
  Schema.String,
  LocalConfigExplicitSecretRefSchema,
);

const LocalConfigSourceEntryBaseSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
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

export const LocalConfigSecretsSchema = Schema.Struct({
  providers: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: LocalConfigSecretProviderSchema,
    }),
  ),
  defaults: Schema.optional(
    Schema.Struct({
      env: Schema.optional(Schema.String),
      file: Schema.optional(Schema.String),
      exec: Schema.optional(Schema.String),
    }),
  ),
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
  secrets: Schema.optional(LocalConfigSecretsSchema),
});

export type LocalConfigSecretProviderSource =
  typeof LocalConfigSecretProviderSourceSchema.Type;
export type LocalConfigSecretProvider =
  typeof LocalConfigSecretProviderSchema.Type;
export type LocalConfigExplicitSecretRef =
  typeof LocalConfigExplicitSecretRefSchema.Type;
export type LocalConfigSecretInput = typeof LocalConfigSecretInputSchema.Type;
export type LocalConfigPolicy = typeof LocalConfigPolicySchema.Type;
export type LocalConfigSecrets = typeof LocalConfigSecretsSchema.Type;
export type LocalExecutorRuntime = typeof LocalExecutorRuntimeSchema.Type;
export type LocalExecutorConfig = typeof LocalExecutorConfigSchema.Type;
