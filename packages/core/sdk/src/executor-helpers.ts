import { Effect, Option, Schema } from "effect";
import { fumadb } from "fumadb";
import { memoryAdapter } from "fumadb/adapters/memory";
import { type Condition, type ConditionBuilder } from "fumadb/query";
import { schema as fumaSchema, type RelationsMap } from "fumadb/schema";
import type { AnyColumn } from "fumadb/schema";

import { ConnectionProviderState } from "./connections";
import {
  coreSchema,
  type CoreSchema,
  type DefinitionsInput,
  type SourceInput,
  type SourceRow,
  type ToolAnnotations,
  type ToolRow,
} from "./core-schema";
import {
  StorageError,
  isStorageFailure,
  makeFumaClient,
  type FumaDb,
  type FumaRow,
  type FumaTables,
  type StorageFailure,
} from "./fuma-runtime";
import type { AnyPlugin, StaticSourceDecl, StaticToolDecl, StaticToolSchema } from "./plugin";
import { assertExecutorScopePolicyTable } from "./scope-policy";
import type { Source, Tool, ToolListFilter } from "./types";

const MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS = 4_000;

// ---------------------------------------------------------------------------
// collectTables — merge core tables with every plugin's declared Fuma table.
// Hosts pass the result to FumaDB when constructing the database client.
// ---------------------------------------------------------------------------

export const collectTables = (plugins: readonly AnyPlugin[]): FumaTables => {
  const merged: FumaTables = { ...coreSchema };
  for (const plugin of plugins) {
    if (!plugin.schema) continue;
    for (const [tableKey, tableDef] of Object.entries(plugin.schema)) {
      if (merged[tableKey]) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: collectTables is a synchronous configuration API
        throw new StorageError({
          message:
            `Duplicate storage table "${tableKey}" contributed by plugin "${plugin.id}"` +
            ` (reserved by core or another plugin)`,
          cause: undefined,
        });
      }
      merged[tableKey] = tableDef as FumaTables[string];
    }
  }

  validateExecutorScopePolicyTables(merged);

  return merged;
};

export const validateExecutorScopePolicyTables = (tables: FumaTables): void => {
  for (const [tableKey, tableDef] of Object.entries(tables)) {
    assertExecutorScopePolicyTable(tableDef, tableKey);
  }
};

export const validateExecutorDbTables = (required: FumaTables, actual: FumaTables): void => {
  const missing = Object.keys(required)
    .filter((tableName) => !actual[tableName])
    .sort();
  if (missing.length === 0) return;

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous startup validation before Executor services are built
  throw new StorageError({
    message: `Executor database is missing required table definitions: ${missing.join(", ")}`,
    cause: {
      missing,
      available: Object.keys(actual).sort(),
    },
  });
};

export const storageFailureFromUnknown = (message: string, cause: unknown): StorageFailure =>
  isStorageFailure(cause) ? cause : new StorageError({ message, cause });

export const pluginStorageFailure = (
  pluginId: string,
  hook: string,
  cause: unknown,
): StorageFailure => storageFailureFromUnknown(`${hook} failed for plugin ${pluginId}`, cause);

export const createDefaultMemoryDb = (tables: FumaTables): { readonly db: FumaDb } => {
  const version = "1.0.0";
  const latestSchema = fumaSchema<string, FumaTables, RelationsMap<FumaTables>>({
    version,
    tables,
  });
  const factory = fumadb({
    namespace: "executor_memory",
    schemas: [latestSchema],
  });

  // oxlint-disable-next-line executor/no-double-cast -- boundary: dynamic plugin table map is known only after collectTables()
  const db = factory.client(memoryAdapter()).orm(version) as unknown as FumaDb;
  return {
    db,
  };
};

// ---------------------------------------------------------------------------
// Row → public projection conversions
// ---------------------------------------------------------------------------

export const rowToSource = (row: SourceRow): Source => ({
  id: row.id,
  scopeId: row.scope_id,
  kind: row.kind,
  name: row.name,
  url: row.url ?? undefined,
  pluginId: row.plugin_id,
  canRemove: Boolean(row.can_remove),
  canRefresh: Boolean(row.can_refresh),
  canEdit: Boolean(row.can_edit),
  runtime: false,
});

export const staticDeclToSource = (decl: StaticSourceDecl, pluginId: string): Source => ({
  id: decl.id,
  scopeId: undefined,
  kind: decl.kind,
  name: decl.name,
  url: decl.url,
  pluginId,
  canRemove: decl.canRemove ?? false,
  canRefresh: decl.canRefresh ?? false,
  canEdit: decl.canEdit ?? false,
  runtime: true,
});

const decodeJsonFromString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

export const decodeJsonColumn = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  return decodeJsonFromString(value).pipe(Option.getOrElse(() => value));
};

export const decodeProviderState = Schema.decodeUnknownOption(ConnectionProviderState);

export const rowToTool = (row: ToolRow, annotations?: ToolAnnotations): Tool => ({
  id: row.id,
  sourceId: row.source_id,
  pluginId: row.plugin_id,
  name: row.name,
  description: row.description,
  inputSchema: decodeJsonColumn(row.input_schema),
  outputSchema: decodeJsonColumn(row.output_schema),
  annotations,
});

export const staticDeclToTool = (
  source: StaticSourceDecl,
  tool: StaticToolDecl,
  pluginId: string,
): Tool => ({
  id: `${source.id}.${tool.name}`,
  sourceId: source.id,
  pluginId,
  name: tool.name,
  description: tool.description,
  inputSchema: toToolJsonSchema(tool.inputSchema),
  outputSchema: toToolJsonSchema(tool.outputSchema, "output"),
  annotations: tool.annotations,
});

export const toToolJsonSchema = (
  schema: StaticToolSchema | undefined,
  direction: "input" | "output" = "input",
): unknown => {
  if (schema == null) return undefined;
  return schema["~standard"].jsonSchema[direction]({
    target: "draft-2020-12",
  });
};

export const EXECUTOR_SOURCE_ID = "executor";
export const EXECUTOR_SOURCE: StaticSourceDecl = {
  id: EXECUTOR_SOURCE_ID,
  kind: "built-in",
  name: "Executor",
  canRemove: false,
  canRefresh: false,
  canEdit: false,
  tools: [],
};

const scopeFilter =
  (scopes: readonly string[]) =>
  (b: ConditionBuilder<Record<string, AnyColumn>>): Condition =>
    scopes.length === 1 ? b("scope_id", "=", scopes[0]!) : b("scope_id", "in", [...scopes]);

export const scopedWhere =
  (
    scopes: readonly string[],
    where?: (b: ConditionBuilder<Record<string, AnyColumn>>) => Condition | boolean,
  ) =>
  (b: ConditionBuilder<Record<string, AnyColumn>>): Condition | boolean =>
    b.and(scopeFilter(scopes)(b), where ? where(b) : true);

export const byId =
  (id: string) =>
  (b: ConditionBuilder<Record<string, AnyColumn>>): Condition =>
    b("id", "=", id);

export const byScopedId =
  (scope: string, id: string) =>
  (b: ConditionBuilder<Record<string, AnyColumn>>): Condition =>
    b.and(b("scope_id", "=", scope), b("id", "=", id)) as Condition;

type CoreTableName = keyof CoreSchema & string;
type CoreRow<TName extends CoreTableName> = FumaRow<CoreSchema[TName]>;
type CoreWhere<_TName extends CoreTableName> = (
  b: ConditionBuilder<Record<string, AnyColumn>>,
) => Condition | boolean;
type CoreFindManyOptions<TName extends CoreTableName> = {
  readonly where?: CoreWhere<TName>;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?:
    | readonly [string, "asc" | "desc"]
    | readonly (readonly [string, "asc" | "desc"])[];
};
type CoreFindFirstOptions<TName extends CoreTableName> = Omit<
  CoreFindManyOptions<TName>,
  "limit" | "offset"
>;

type LooseStorageDb = {
  readonly count: (tableName: string, options?: unknown) => Promise<number>;
  readonly create: (
    tableName: string,
    row: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readonly createMany: (
    tableName: string,
    rows: readonly Record<string, unknown>[],
  ) => Promise<readonly unknown[]>;
  readonly deleteMany: (tableName: string, options?: unknown) => Promise<void>;
  readonly findFirst: (
    tableName: string,
    options?: unknown,
  ) => Promise<Record<string, unknown> | null>;
  readonly findMany: (
    tableName: string,
    options?: unknown,
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly updateMany: (tableName: string, options: unknown) => Promise<void>;
};

const asLooseStorageDb = (db: unknown): LooseStorageDb => db as LooseStorageDb;

export const makeCoreDb = (fuma: ReturnType<typeof makeFumaClient>) => ({
  count: <TName extends CoreTableName>(
    tableName: TName,
    options?: { readonly where?: CoreWhere<TName> },
  ): Effect.Effect<number, StorageFailure> =>
    fuma.use(`${tableName}.count`, (db) => asLooseStorageDb(db).count(tableName, options)),
  create: <TName extends CoreTableName>(
    tableName: TName,
    row: Record<string, unknown>,
  ): Effect.Effect<CoreRow<TName>, StorageFailure> =>
    fuma.use(`${tableName}.create`, (db) =>
      asLooseStorageDb(db).create(tableName, row),
    ) as Effect.Effect<CoreRow<TName>, StorageFailure>,
  createMany: <TName extends CoreTableName>(
    tableName: TName,
    rows: readonly Record<string, unknown>[],
  ): Effect.Effect<void, StorageFailure> =>
    rows.length === 0
      ? Effect.void
      : fuma
          .use(`${tableName}.createMany`, (db) => asLooseStorageDb(db).createMany(tableName, rows))
          .pipe(Effect.asVoid),
  deleteMany: <TName extends CoreTableName>(
    tableName: TName,
    options: { readonly where?: CoreWhere<TName> } = {},
  ): Effect.Effect<void, StorageFailure> =>
    fuma.use(`${tableName}.deleteMany`, (db) =>
      asLooseStorageDb(db).deleteMany(tableName, options),
    ),
  findFirst: <TName extends CoreTableName>(
    tableName: TName,
    options: CoreFindFirstOptions<TName>,
  ): Effect.Effect<CoreRow<TName> | null, StorageFailure> =>
    fuma.use(`${tableName}.findFirst`, (db) =>
      asLooseStorageDb(db).findFirst(tableName, options),
    ) as Effect.Effect<CoreRow<TName> | null, StorageFailure>,
  findMany: <TName extends CoreTableName>(
    tableName: TName,
    options: CoreFindManyOptions<TName> = {},
  ): Effect.Effect<readonly CoreRow<TName>[], StorageFailure> =>
    fuma.use(`${tableName}.findMany`, (db) =>
      asLooseStorageDb(db).findMany(tableName, options),
    ) as Effect.Effect<readonly CoreRow<TName>[], StorageFailure>,
  updateMany: <TName extends CoreTableName>(
    tableName: TName,
    options: {
      readonly where?: CoreWhere<TName>;
      readonly set: Record<string, unknown>;
    },
  ): Effect.Effect<void, StorageFailure> =>
    fuma.use(`${tableName}.updateMany`, (db) =>
      asLooseStorageDb(db).updateMany(tableName, options),
    ),
});

// ---------------------------------------------------------------------------
// Dynamic-row writers — used by ctx.core.sources.register. Static sources
// never touch these functions.
// ---------------------------------------------------------------------------

// Upsert shape: delete any existing source + tools + definitions for
// `input.id` before creating fresh rows. Keeps replayable — boot-time
// sync from executor.jsonc can call register() on rows that already
// exist without tripping a UNIQUE constraint.
export const writeSourceInput = (
  core: ReturnType<typeof makeCoreDb>,
  pluginId: string,
  input: SourceInput,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* deleteSourceById(core, input.id, input.scope);

    const now = new Date();
    yield* core.create("source", {
      id: input.id,
      scope_id: input.scope,
      plugin_id: pluginId,
      kind: input.kind,
      name: input.name,
      url: input.url ?? null,
      can_remove: input.canRemove ?? true,
      can_refresh: input.canRefresh ?? false,
      can_edit: input.canEdit ?? false,
      created_at: now,
      updated_at: now,
    });

    const toolsById = new Map<string, (typeof input.tools)[number]>();
    for (const tool of input.tools) {
      toolsById.set(`${input.id}.${tool.name}`, tool);
    }
    const tools = [...toolsById.entries()];

    if (tools.length > 0) {
      yield* core.createMany(
        "tool",
        tools.map(([id, tool]) => ({
          id,
          scope_id: input.scope,
          source_id: input.id,
          plugin_id: pluginId,
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema ?? null,
          output_schema: tool.outputSchema ?? null,
          created_at: now,
          updated_at: now,
        })),
      );
    }
  });

// Delete a source and its tools + definitions at ONE specific scope.
// The helper pins `scope_id = scopeId` so it never widens into a stack-wide
// wipe; a bystander scope's rows with a colliding `source_id` must survive.
export const deleteSourceById = (
  core: ReturnType<typeof makeCoreDb>,
  sourceId: string,
  scopeId: string,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* core.deleteMany("tool", {
      where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scopeId)),
    });
    yield* core.deleteMany("definition", {
      where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scopeId)),
    });
    yield* core.deleteMany("source", {
      where: byScopedId(scopeId, sourceId),
    });
  });

export const writeDefinitions = (
  core: ReturnType<typeof makeCoreDb>,
  pluginId: string,
  input: DefinitionsInput,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    // Pin the delete to `input.scope` so an inner-scope writer cannot remove
    // outer-scope definitions for the same source id.
    yield* core.deleteMany("definition", {
      where: (b) => b.and(b("source_id", "=", input.sourceId), b("scope_id", "=", input.scope)),
    });
    const entries = Object.entries(input.definitions);
    if (entries.length === 0) return;
    const now = new Date();
    yield* core.createMany(
      "definition",
      entries.map(([name, schema]) => ({
        id: `${input.sourceId}.${name}`,
        scope_id: input.scope,
        source_id: input.sourceId,
        plugin_id: pluginId,
        name,
        schema: schema as Record<string, unknown>,
        created_at: now,
      })),
    );
  });

// ---------------------------------------------------------------------------
// Filtering — shared between dynamic (DB) and static (in-memory) pools
// so `tools.list({ query, sourceId })` matches across both.
// ---------------------------------------------------------------------------

export const toolMatchesFilter = (tool: Tool, filter: ToolListFilter): boolean => {
  if (filter.sourceId && tool.sourceId !== filter.sourceId) return false;
  if (filter.query) {
    const q = filter.query.toLowerCase();
    const hay = `${tool.name} ${tool.description}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
};

export const approvalArgumentPreview = (args: unknown): string => {
  const text = JSON.stringify(args ?? {}, null, 2) ?? "null";
  return text.length > MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS
    ? `${text.slice(0, MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS)}...`
    : text;
};
