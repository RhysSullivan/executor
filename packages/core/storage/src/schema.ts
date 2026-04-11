import { Effect } from "effect";

import { StorageFieldError, StorageModelError } from "./errors";
import type { StorageCapabilities } from "./types";

export type ExecutorFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | "string[]"
  | "number[]"
  | "bytes";

export interface ExecutorFieldAttribute {
  readonly type: ExecutorFieldType;
  readonly columnName?: string;
  readonly required?: boolean;
  readonly unique?: boolean;
  readonly sortable?: boolean;
  readonly defaultValue?: unknown | (() => unknown);
  readonly references?: {
    readonly model: string;
    readonly field: string;
    readonly onDelete?: "cascade" | "restrict" | "set_null";
  };
}

export interface ExecutorIndexAttribute {
  readonly name: string;
  readonly fields: readonly string[];
  readonly unique?: boolean;
}

export interface ExecutorModelSchema {
  readonly modelName: string;
  readonly tableName: string;
  readonly fields: Record<string, ExecutorFieldAttribute>;
  readonly primaryKey: readonly string[];
  readonly indexes?: readonly ExecutorIndexAttribute[];
  readonly disableMigrations?: boolean;
  readonly order?: number;
}

export type ExecutorDBSchema = Record<string, ExecutorModelSchema>;

export interface ExecutorSchemaContributor {
  readonly storage?: {
    readonly schema?: ExecutorDBSchema;
  };
}

export interface ComposeExecutorSchemaOptions<
  TPlugin extends ExecutorSchemaContributor = ExecutorSchemaContributor,
> {
  readonly core?: ExecutorDBSchema;
  readonly plugins?: readonly TPlugin[];
  readonly auth?: ExecutorDBSchema;
}

export const executorCoreSchema = {
  sources: {
    modelName: "sources",
    tableName: "sources",
    primaryKey: ["id", "scopeId"],
    fields: {
      id: { type: "string", required: true },
      scopeId: { type: "string", columnName: "scope_id", required: true },
      name: { type: "string", required: true },
      kind: { type: "string", required: true },
      config: { type: "json", required: true, defaultValue: () => ({}) },
      createdAt: { type: "date", required: true, sortable: true, defaultValue: () => new Date() },
    },
  },
  tools: {
    modelName: "tools",
    tableName: "tools",
    primaryKey: ["id", "scopeId"],
    indexes: [{ name: "idx_tools_source", fields: ["scopeId", "sourceId"] }],
    fields: {
      id: { type: "string", required: true },
      scopeId: { type: "string", columnName: "scope_id", required: true },
      sourceId: { type: "string", columnName: "source_id", required: true },
      pluginKey: { type: "string", columnName: "plugin_key", required: true },
      name: { type: "string", required: true },
      description: { type: "string" },
      mayElicit: { type: "boolean", columnName: "may_elicit", defaultValue: false },
      inputSchema: { type: "json", columnName: "input_schema" },
      outputSchema: { type: "json", columnName: "output_schema" },
      createdAt: {
        type: "date",
        columnName: "created_at",
        required: true,
        defaultValue: () => new Date(),
      },
    },
  },
  toolDefinitions: {
    modelName: "toolDefinitions",
    tableName: "tool_definitions",
    primaryKey: ["name", "scopeId"],
    fields: {
      name: { type: "string", required: true },
      scopeId: { type: "string", columnName: "scope_id", required: true },
      schema: { type: "json", required: true },
    },
  },
  secrets: {
    modelName: "secrets",
    tableName: "secrets",
    primaryKey: ["id", "scopeId"],
    fields: {
      id: { type: "string", required: true },
      scopeId: { type: "string", columnName: "scope_id", required: true },
      name: { type: "string", required: true },
      purpose: { type: "string" },
      provider: { type: "string" },
      encryptedValue: { type: "bytes", columnName: "encrypted_value" },
      iv: { type: "bytes" },
      createdAt: {
        type: "date",
        columnName: "created_at",
        required: true,
        defaultValue: () => new Date(),
      },
    },
  },
  policies: {
    modelName: "policies",
    tableName: "policies",
    primaryKey: ["id", "scopeId"],
    fields: {
      id: { type: "string", required: true },
      scopeId: { type: "string", columnName: "scope_id", required: true },
      name: { type: "string", required: true },
      action: { type: "string", required: true },
      matchToolPattern: { type: "string", columnName: "match_tool_pattern" },
      matchSourceId: { type: "string", columnName: "match_source_id" },
      priority: { type: "number", required: true, sortable: true, defaultValue: 0 },
      createdAt: {
        type: "date",
        columnName: "created_at",
        required: true,
        defaultValue: () => new Date(),
      },
    },
  },
  pluginKv: {
    modelName: "pluginKv",
    tableName: "plugin_kv",
    primaryKey: ["scopeId", "namespace", "key"],
    indexes: [{ name: "idx_plugin_kv_namespace", fields: ["scopeId", "namespace"] }],
    fields: {
      scopeId: { type: "string", columnName: "scope_id", required: true },
      namespace: { type: "string", required: true },
      key: { type: "string", required: true },
      value: { type: "string", required: true },
    },
  },
} as const satisfies ExecutorDBSchema;

export const mergeSchemas = (...schemas: readonly ExecutorDBSchema[]): ExecutorDBSchema => {
  const models: Record<string, ExecutorModelSchema> = {};
  const tableToModel = new Map<string, string>();

  for (const schema of schemas) {
    for (const [modelName, model] of Object.entries(schema)) {
      const existing = models[modelName];
      if (existing) {
        models[modelName] = mergeModel(existing, model);
        continue;
      }
      const existingTable = tableToModel.get(model.tableName);
      if (existingTable) {
        throw new Error(
          `Duplicate storage table "${model.tableName}" for ${existingTable} and ${modelName}`,
        );
      }
      models[modelName] = model;
      tableToModel.set(model.tableName, modelName);
    }
  }

  const merged = Object.fromEntries(
    Object.entries(models).sort(
      ([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0) || a.modelName.localeCompare(b.modelName),
    ),
  );

  validateMergedSchema(merged);
  return merged;
};

const mergeModel = (base: ExecutorModelSchema, addition: ExecutorModelSchema): ExecutorModelSchema => {
  if (base.tableName !== addition.tableName) {
    throw new Error(
      `Storage model "${base.modelName}" has conflicting tableName: "${base.tableName}" vs "${addition.tableName}"`,
    );
  }
  if (!arraysEqual(base.primaryKey, addition.primaryKey)) {
    throw new Error(
      `Storage model "${base.modelName}" has conflicting primaryKey: [${base.primaryKey.join(", ")}] vs [${addition.primaryKey.join(", ")}]`,
    );
  }
  if (addition.order !== undefined && base.order !== undefined && base.order !== addition.order) {
    throw new Error(
      `Storage model "${base.modelName}" has conflicting order: ${base.order} vs ${addition.order}`,
    );
  }
  if (
    addition.disableMigrations !== undefined &&
    base.disableMigrations !== undefined &&
    base.disableMigrations !== addition.disableMigrations
  ) {
    throw new Error(
      `Storage model "${base.modelName}" has conflicting disableMigrations: ${base.disableMigrations} vs ${addition.disableMigrations}`,
    );
  }

  const fields: Record<string, ExecutorFieldAttribute> = { ...base.fields };
  for (const [fieldName, field] of Object.entries(addition.fields)) {
    if (fields[fieldName]) {
      throw new Error(
        `Storage model "${base.modelName}" already has field "${fieldName}"; field additions must use unique names`,
      );
    }
    if (field.required) {
      throw new Error(
        `Storage model "${base.modelName}" cannot add required field "${fieldName}"; added fields must be optional`,
      );
    }
    fields[fieldName] = field;
  }

  const indexes = [...(base.indexes ?? []), ...(addition.indexes ?? [])];

  return {
    modelName: base.modelName,
    tableName: base.tableName,
    primaryKey: base.primaryKey,
    fields,
    indexes: indexes.length > 0 ? indexes : undefined,
    disableMigrations: base.disableMigrations ?? addition.disableMigrations,
    order: base.order ?? addition.order,
  };
};

const arraysEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export const composeExecutorSchema = <
  TPlugin extends ExecutorSchemaContributor = ExecutorSchemaContributor,
>({
  core = executorCoreSchema,
  plugins = [],
  auth,
}: ComposeExecutorSchemaOptions<TPlugin>): ExecutorDBSchema =>
  mergeSchemas(
    core,
    ...plugins.flatMap((plugin) => (plugin.storage?.schema ? [plugin.storage.schema] : [])),
    ...(auth ? [auth] : []),
  );

export const getModel = (schema: ExecutorDBSchema, model: string) => {
  const modelSchema = schema[model];
  if (!modelSchema) {
    return Effect.fail(new StorageModelError({ model, message: `Unknown model "${model}"` }));
  }
  return Effect.succeed(modelSchema);
};

export const getField = (model: ExecutorModelSchema, field: string) => {
  const fieldSchema = model.fields[field];
  if (!fieldSchema) {
    return Effect.fail(
      new StorageFieldError({
        model: model.modelName,
        field,
        message: `Unknown field "${field}" on model "${model.modelName}"`,
      }),
    );
  }
  return Effect.succeed(fieldSchema);
};

export const validateSchemaCapabilities = (
  adapterId: string,
  capabilities: StorageCapabilities,
  schema: ExecutorDBSchema,
) =>
  Effect.gen(function* () {
    for (const model of Object.values(schema)) {
      for (const [fieldName, field] of Object.entries(model.fields)) {
        const requiredCapability = capabilityForFieldType(field.type);
        if (requiredCapability && !capabilities[requiredCapability]) {
          return yield* new StorageFieldError({
            model: model.modelName,
            field: fieldName,
            message: `Adapter "${adapterId}" does not support field type "${field.type}"`,
          });
        }
      }
    }
  });

const capabilityForFieldType = (type: ExecutorFieldType): keyof StorageCapabilities | undefined => {
  switch (type) {
    case "json":
      return "supportsJSON";
    case "date":
      return "supportsDates";
    case "boolean":
      return "supportsBooleans";
    case "string[]":
    case "number[]":
      return "supportsArrays";
    case "bytes":
      return "supportsBytes";
    default:
      return undefined;
  }
};

const validateMergedSchema = (schema: ExecutorDBSchema): void => {
  const indexToModel = new Map<string, string>();

  for (const [schemaKey, model] of Object.entries(schema)) {
    if (model.modelName !== schemaKey) {
      throw new Error(
        `Storage model key "${schemaKey}" does not match declared modelName "${model.modelName}"`,
      );
    }

    for (const field of model.primaryKey) {
      if (!model.fields[field]) {
        throw new Error(
          `Primary key field "${field}" does not exist on model "${model.modelName}"`,
        );
      }
    }

    for (const index of model.indexes ?? []) {
      const existing = indexToModel.get(index.name);
      if (existing) {
        throw new Error(
          `Duplicate storage index "${index.name}" for ${existing} and ${model.modelName}`,
        );
      }
      indexToModel.set(index.name, model.modelName);

      for (const field of index.fields) {
        if (!model.fields[field]) {
          throw new Error(
            `Index "${index.name}" references missing field "${field}" on model "${model.modelName}"`,
          );
        }
      }
    }
  }

  for (const model of Object.values(schema)) {
    for (const [fieldName, field] of Object.entries(model.fields)) {
      const reference = field.references;
      if (!reference) continue;

      const referencedModel = schema[reference.model];
      if (!referencedModel) {
        throw new Error(
          `Field "${model.modelName}.${fieldName}" references unknown model "${reference.model}"`,
        );
      }
      if (!referencedModel.fields[reference.field]) {
        throw new Error(
          `Field "${model.modelName}.${fieldName}" references missing field "${reference.model}.${reference.field}"`,
        );
      }
    }
  }
};
