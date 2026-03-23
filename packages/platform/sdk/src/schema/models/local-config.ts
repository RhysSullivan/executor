import {
  Schema,
} from "effect";

import {
  StoredHttpOauth2SetupSchema,
  SourceTransportSchema,
  StringArraySchema,
  StringMapSchema,
} from "@executor/source-core";

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

export const LocalConfigSourceConnectionSchema = Schema.Struct({
  endpoint: Schema.String,
  auth: Schema.optional(LocalConfigSecretInputSchema),
});

const LocalConfigSourceEntryBaseSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  connection: LocalConfigSourceConnectionSchema,
});

const OpenApiLocalConfigBindingSchema = Schema.Struct({
  specUrl: Schema.String,
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
  oauth2: Schema.optional(Schema.NullOr(StoredHttpOauth2SetupSchema)),
});

const GraphqlLocalConfigBindingSchema = Schema.Struct({
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
  oauth2: Schema.optional(Schema.NullOr(StoredHttpOauth2SetupSchema)),
});

const GoogleDiscoveryLocalConfigBindingSchema = Schema.Struct({
  service: Schema.String,
  version: Schema.String,
  discoveryUrl: Schema.optional(Schema.NullOr(Schema.String)),
  defaultHeaders: Schema.optional(Schema.NullOr(StringMapSchema)),
  scopes: Schema.optional(Schema.Array(Schema.String)),
});

const McpLocalConfigBindingSchema = Schema.Struct({
  transport: Schema.optional(Schema.NullOr(SourceTransportSchema)),
  queryParams: Schema.optional(Schema.NullOr(StringMapSchema)),
  headers: Schema.optional(Schema.NullOr(StringMapSchema)),
  command: Schema.optional(Schema.NullOr(Schema.String)),
  args: Schema.optional(Schema.NullOr(StringArraySchema)),
  env: Schema.optional(Schema.NullOr(StringMapSchema)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
});

const OpenApiLocalConfigSourceSchema = Schema.extend(
  LocalConfigSourceEntryBaseSchema,
  Schema.Struct({
    kind: Schema.Literal("openapi"),
    binding: OpenApiLocalConfigBindingSchema,
  }),
);

const GraphqlLocalConfigSourceSchema = Schema.extend(
  LocalConfigSourceEntryBaseSchema,
  Schema.Struct({
    kind: Schema.Literal("graphql"),
    binding: GraphqlLocalConfigBindingSchema,
  }),
);

const GoogleDiscoveryLocalConfigSourceSchema = Schema.extend(
  LocalConfigSourceEntryBaseSchema,
  Schema.Struct({
    kind: Schema.Literal("google_discovery"),
    binding: GoogleDiscoveryLocalConfigBindingSchema,
  }),
);

const McpLocalConfigSourceSchema = Schema.extend(
  LocalConfigSourceEntryBaseSchema,
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    binding: McpLocalConfigBindingSchema,
  }),
);

export const LocalConfigSourceSchema = Schema.Union(
  OpenApiLocalConfigSourceSchema,
  GraphqlLocalConfigSourceSchema,
  GoogleDiscoveryLocalConfigSourceSchema,
  McpLocalConfigSourceSchema,
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
