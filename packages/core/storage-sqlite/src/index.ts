import Database from "better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { Effect, Exit } from "effect";

import {
  type CountArgs,
  type CreateArgs,
  type DeleteArgs,
  type DeleteManyArgs,
  type ExecutorDBSchema,
  type ExecutorFieldAttribute,
  type ExecutorFieldType,
  type ExecutorModelSchema,
  type ExecutorStorage,
  type ExecutorStorageTransaction,
  type FindManyArgs,
  type FindOneArgs,
  type StorageCapabilities,
  type StorageError,
  type UpdateArgs,
  type UpdateManyArgs,
  type Where,
  executorCoreSchema,
  getField,
  getModel,
  validateSchemaCapabilities,
  StorageFieldError,
  StorageQueryError,
} from "@executor/storage";

type Row = Record<string, unknown>;
type SqliteDatabase = BetterSQLite3Database<Record<string, never>> & {
  readonly $client: Database.Database;
};

export interface SqliteStorageOptions {
  readonly schema?: ExecutorDBSchema;
  readonly migrate?: boolean;
}

export interface FileSqliteStorageOptions extends SqliteStorageOptions {
  readonly filename: string;
}

const capabilities = {
  supportsJSON: true,
  supportsDates: true,
  supportsBooleans: true,
  supportsArrays: true,
  supportsBytes: true,
  supportsTransactions: true,
  supportsReturning: true,
} satisfies StorageCapabilities;

export const makeInMemorySqliteStorage = (
  options?: SqliteStorageOptions,
): Effect.Effect<ExecutorStorage, StorageError> =>
  makeFileSqliteStorage({ ...options, filename: ":memory:" });

export const makeFileSqliteStorage = (
  options: FileSqliteStorageOptions,
): Effect.Effect<ExecutorStorage, StorageError> =>
  Effect.gen(function* () {
    const db = drizzle(new Database(options.filename));
    return yield* makeSqliteStorage(db as SqliteDatabase, options);
  });

export const makeSqliteStorage = (
  db: SqliteDatabase,
  options?: SqliteStorageOptions,
): Effect.Effect<ExecutorStorage, StorageError> =>
  Effect.gen(function* () {
    const schema = options?.schema ?? executorCoreSchema;
    yield* validateSchemaCapabilities("sqlite", capabilities, schema);
    if (options?.migrate ?? true) {
      yield* migrate(db, schema);
    }
    return makeStorage(db, schema);
  });

const makeStorage = (db: SqliteDatabase, schema: ExecutorDBSchema): ExecutorStorage => {
  const txStorage: ExecutorStorageTransaction = {
    id: "sqlite",
    capabilities,
    create: (args) => create(db, schema, args),
    findOne: (args) => findOne(db, schema, args),
    findMany: (args) => findMany(db, schema, args),
    update: (args) => update(db, schema, args),
    updateMany: (args) => updateMany(db, schema, args),
    delete: (args) => deleteOne(db, schema, args),
    deleteMany: (args) => deleteMany(db, schema, args),
    count: (args) => count(db, schema, args),
  };

  return {
    ...txStorage,
    transaction: (callback) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* run(db, "transaction", sql`BEGIN`);
          const exit = yield* restore(callback(txStorage)).pipe(Effect.exit);

          if (Exit.isSuccess(exit)) {
            yield* run(db, "transaction", sql`COMMIT`);
          } else {
            yield* run(db, "transaction", sql`ROLLBACK`);
          }

          return yield* Exit.matchEffect(exit, {
            onFailure: Effect.failCause,
            onSuccess: Effect.succeed,
          });
        }),
      ),
  };
};

const migrate = (db: SqliteDatabase, schema: ExecutorDBSchema) =>
  Effect.gen(function* () {
    for (const model of Object.values(schema)) {
      yield* run(db, model.modelName, createTableSql(model));
      for (const index of model.indexes ?? []) {
        yield* run(db, model.modelName, createIndexSql(model, index));
      }
    }
  });

const create = <T>(
  db: SqliteDatabase,
  schema: ExecutorDBSchema,
  args: CreateArgs,
): Effect.Effect<T, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    const row = yield* materializeRow(model.fields, args.model, args.data);
    const columns = Object.keys(model.fields);
    const query = sql`
      INSERT INTO ${sql.identifier(model.tableName)}
      (${sql.join(
        columns.map((field) => sql.identifier(columnName(model.fields[field]!, field))),
        sql`, `,
      )})
      VALUES (${sql.join(
        columns.map((field) => sql`${toDriverValue(model.fields[field]!, row[field])}`),
        sql`, `,
      )})
    `;

    yield* run(db, args.model, query);
    return fromDriverRow(model, row) as T;
  });

const findOne = <T>(db: SqliteDatabase, schema: ExecutorDBSchema, args: FindOneArgs) =>
  findMany<T>(db, schema, { ...args, limit: 1 }).pipe(Effect.map((rows) => rows[0] ?? null));

const findMany = <T>(
  db: SqliteDatabase,
  schema: ExecutorDBSchema,
  args: FindManyArgs,
): Effect.Effect<readonly T[], StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where ?? [], args.sortBy?.field, args.select);
    const query = selectSql(
      model,
      args.where ?? [],
      args.select,
      args.sortBy,
      args.limit,
      args.offset,
    );
    const rows = yield* all<Row>(db, args.model, query);
    return rows.map((row: Row) => fromDriverRow(model, row, args.select) as T);
  });

const update = <T>(
  db: SqliteDatabase,
  schema: ExecutorDBSchema,
  args: UpdateArgs,
): Effect.Effect<T | null, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where, undefined, undefined);
    const updateFields = Object.keys(args.update);
    for (const field of updateFields) yield* getField(model, field);

    const target = yield* get<Row>(db, args.model, selectRowIdSql(model, args.where));
    if (!target) return null;
    yield* run(db, args.model, updateByRowIdSql(model, updateFields, args.update, target.__rowid));
    const updated = yield* get<Row>(db, args.model, selectByRowIdSql(model, target.__rowid));
    return updated ? (fromDriverRow(model, updated) as T) : null;
  });

const updateMany = (
  db: SqliteDatabase,
  schema: ExecutorDBSchema,
  args: UpdateManyArgs,
): Effect.Effect<number, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where, undefined, undefined);
    const updateFields = Object.keys(args.update);
    for (const field of updateFields) yield* getField(model, field);
    const result = yield* run(
      db,
      args.model,
      updateSql(model, updateFields, args.update, args.where),
    );
    return result.changes;
  });

const deleteOne = (
  db: SqliteDatabase,
  schema: ExecutorDBSchema,
  args: DeleteArgs,
): Effect.Effect<boolean, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where, undefined, undefined);
    const target = yield* get<Row>(db, args.model, selectRowIdSql(model, args.where));
    if (!target) return false;
    const result = yield* run(
      db,
      args.model,
      sql`
      DELETE FROM ${sql.identifier(model.tableName)} WHERE rowid = ${target.__rowid}
    `,
    );
    return result.changes > 0;
  });

const deleteMany = (
  db: SqliteDatabase,
  schema: ExecutorDBSchema,
  args: DeleteManyArgs,
): Effect.Effect<number, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where, undefined, undefined);
    const result = yield* run(
      db,
      args.model,
      sql`
      DELETE FROM ${sql.identifier(model.tableName)}
      ${whereSql(model, args.where)}
    `,
    );
    return result.changes;
  });

const count = (
  db: SqliteDatabase,
  schema: ExecutorDBSchema,
  args: CountArgs,
): Effect.Effect<number, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where ?? [], undefined, undefined);
    const row = yield* get<{ count: number }>(
      db,
      args.model,
      sql`
      SELECT COUNT(*) AS count
      FROM ${sql.identifier(model.tableName)}
      ${whereSql(model, args.where ?? [])}
    `,
    );
    return row?.count ?? 0;
  });

const validateQuery = (
  model: ExecutorModelSchema,
  where: readonly Where[],
  sortField: string | undefined,
  select: readonly string[] | undefined,
) =>
  Effect.gen(function* () {
    for (const clause of where) yield* getField(model, clause.field);
    if (sortField) yield* getField(model, sortField);
    for (const field of select ?? []) yield* getField(model, field);
  });

const materializeRow = (
  fields: Record<string, ExecutorFieldAttribute>,
  model: string,
  data: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const row: Row = {};
    for (const field of Object.keys(data)) {
      if (!fields[field]) {
        return yield* new StorageFieldError({ model, field, message: `Unknown field "${field}"` });
      }
    }
    for (const [field, attr] of Object.entries(fields)) {
      const value = data[field] ?? evaluateDefault(attr.defaultValue) ?? null;
      if (attr.required && value === null) {
        return yield* new StorageFieldError({
          model,
          field,
          message: `Missing required field "${field}"`,
        });
      }
      row[field] = value;
    }
    return row;
  });

const selectSql = (
  model: ExecutorModelSchema,
  where: readonly Where[],
  select: readonly string[] | undefined,
  sortBy: FindManyArgs["sortBy"],
  limit: number | undefined,
  offset: number | undefined,
) => sql`
  SELECT ${selectColumnsSql(model, select)}
  FROM ${sql.identifier(model.tableName)}
  ${whereSql(model, where)}
  ${sortBy ? orderBySql(model, sortBy) : sql``}
  ${typeof limit === "number" ? sql`LIMIT ${limit}` : sql``}
  ${typeof offset === "number" ? sql`OFFSET ${offset}` : sql``}
`;

const selectRowIdSql = (model: ExecutorModelSchema, where: readonly Where[]) => sql`
  SELECT rowid AS __rowid
  FROM ${sql.identifier(model.tableName)}
  ${whereSql(model, where)}
  LIMIT 1
`;

const selectByRowIdSql = (model: ExecutorModelSchema, rowid: unknown) => sql`
  SELECT ${selectColumnsSql(model)}
  FROM ${sql.identifier(model.tableName)}
  WHERE rowid = ${rowid}
`;

const updateByRowIdSql = (
  model: ExecutorModelSchema,
  updateFields: readonly string[],
  update: Record<string, unknown>,
  rowid: unknown,
) => sql`
  UPDATE ${sql.identifier(model.tableName)}
  SET ${setSql(model, updateFields, update)}
  WHERE rowid = ${rowid}
`;

const updateSql = (
  model: ExecutorModelSchema,
  updateFields: readonly string[],
  update: Record<string, unknown>,
  where: readonly Where[],
) => sql`
  UPDATE ${sql.identifier(model.tableName)}
  SET ${setSql(model, updateFields, update)}
  ${whereSql(model, where)}
`;

const selectColumnsSql = (model: ExecutorModelSchema, select?: readonly string[]) => {
  const fields = select ?? Object.keys(model.fields);
  return sql.join(
    fields.map((field) => {
      const attr = model.fields[field]!;
      return sql`${sql.identifier(columnName(attr, field))} AS ${sql.identifier(field)}`;
    }),
    sql`, `,
  );
};

const setSql = (
  model: ExecutorModelSchema,
  updateFields: readonly string[],
  update: Record<string, unknown>,
) =>
  sql.join(
    updateFields.map((field) => {
      const attr = model.fields[field]!;
      return sql`${sql.identifier(columnName(attr, field))} = ${toDriverValue(attr, update[field])}`;
    }),
    sql`, `,
  );

const whereSql = (model: ExecutorModelSchema, where: readonly Where[]) => {
  if (where.length === 0) return sql``;
  const clauses: SQL[] = [];
  for (const [index, clause] of where.entries()) {
    if (index > 0) {
      clauses.push(sql.raw(` ${clause.connector ?? "AND"} `));
    }
    clauses.push(clauseSql(model, clause));
  }
  return sql`WHERE ${sql.join(clauses)}`;
};

const clauseSql = (model: ExecutorModelSchema, clause: Where) => {
  const attr = model.fields[clause.field]!;
  const column = sql.identifier(columnName(attr, clause.field));
  const value = toDriverValue(attr, clause.value);
  const operator = clause.operator ?? "eq";
  const insensitive = clause.mode === "insensitive";
  const left = insensitive ? sql`LOWER(${column})` : sql`${column}`;
  const comparableValue = insensitive && typeof value === "string" ? value.toLowerCase() : value;

  switch (operator) {
    case "eq":
      return value === null ? sql`${column} IS NULL` : sql`${left} = ${comparableValue}`;
    case "ne":
      return value === null ? sql`${column} IS NOT NULL` : sql`${left} <> ${comparableValue}`;
    case "lt":
      return sql`${left} < ${comparableValue}`;
    case "lte":
      return sql`${left} <= ${comparableValue}`;
    case "gt":
      return sql`${left} > ${comparableValue}`;
    case "gte":
      return sql`${left} >= ${comparableValue}`;
    case "in":
      return inSql(left, attr, clause.value, insensitive, false);
    case "not_in":
      return inSql(left, attr, clause.value, insensitive, true);
    case "contains":
      return sql`${left} LIKE ${`%${String(comparableValue)}%`}`;
    case "starts_with":
      return sql`${left} LIKE ${`${String(comparableValue)}%`}`;
    case "ends_with":
      return sql`${left} LIKE ${`%${String(comparableValue)}`}`;
  }
};

const inSql = (
  left: SQL,
  attr: ExecutorFieldAttribute,
  value: Where["value"],
  insensitive: boolean,
  negate: boolean,
) => {
  if (!Array.isArray(value) || value.length === 0) return negate ? sql`1 = 1` : sql`1 = 0`;
  const values = value.map((item) => {
    const driverValue = toDriverValue(attr, item);
    return insensitive && typeof driverValue === "string" ? driverValue.toLowerCase() : driverValue;
  });
  return negate
    ? sql`${left} NOT IN (${sql.join(
        values.map((item) => sql`${item}`),
        sql`, `,
      )})`
    : sql`${left} IN (${sql.join(
        values.map((item) => sql`${item}`),
        sql`, `,
      )})`;
};

const orderBySql = (model: ExecutorModelSchema, sortBy: NonNullable<FindManyArgs["sortBy"]>) => {
  const attr = model.fields[sortBy.field]!;
  return sql`ORDER BY ${sql.identifier(columnName(attr, sortBy.field))} ${sql.raw(sortBy.direction.toUpperCase())}`;
};

const createTableSql = (model: ExecutorModelSchema) => {
  const columns = Object.entries(model.fields).map(([field, attr]) => {
    const constraints = [quoteIdentifier(columnName(attr, field)), sqliteType(attr.type)];
    if (attr.required) constraints.push("NOT NULL");
    return constraints.join(" ");
  });
  const tableConstraints = [
    `PRIMARY KEY (${model.primaryKey.map((field) => quoteIdentifier(columnName(model.fields[field]!, field))).join(", ")})`,
    ...Object.entries(model.fields)
      .filter(([, attr]) => attr.unique)
      .map(([field, attr]) => `UNIQUE (${quoteIdentifier(columnName(attr, field))})`),
  ];

  return sql.raw(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(model.tableName)} (${[...columns, ...tableConstraints].join(", ")})`,
  );
};

const createIndexSql = (
  model: ExecutorModelSchema,
  index: NonNullable<ExecutorModelSchema["indexes"]>[number],
) =>
  sql.raw(
    `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdentifier(index.name)} ON ${quoteIdentifier(
      model.tableName,
    )} (${index.fields.map((field) => quoteIdentifier(columnName(model.fields[field]!, field))).join(", ")})`,
  );

const sqliteType = (type: ExecutorFieldType) => {
  switch (type) {
    case "string":
    case "json":
    case "string[]":
    case "number[]":
      return "TEXT";
    case "number":
    case "boolean":
    case "date":
      return "INTEGER";
    case "bytes":
      return "BLOB";
  }
};

const fromDriverRow = (model: ExecutorModelSchema, row: Row, select?: readonly string[]) => {
  const fields = select ?? Object.keys(model.fields);
  return Object.fromEntries(
    fields.map((field) => [field, fromDriverValue(model.fields[field]!, row[field])]),
  );
};

const toDriverValue = (attr: ExecutorFieldAttribute, value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  switch (attr.type) {
    case "boolean":
      return value ? 1 : 0;
    case "date":
      return value instanceof Date ? value.getTime() : value;
    case "json":
    case "string[]":
    case "number[]":
      return JSON.stringify(value);
    case "bytes":
      return value;
    default:
      return value;
  }
};

const fromDriverValue = (attr: ExecutorFieldAttribute, value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  switch (attr.type) {
    case "boolean":
      return value === true || value === 1;
    case "date":
      return value instanceof Date ? value : new Date(Number(value));
    case "json":
    case "string[]":
    case "number[]":
      return typeof value === "string" ? JSON.parse(value) : value;
    case "bytes":
      return value;
    default:
      return value;
  }
};

const evaluateDefault = (defaultValue: ExecutorFieldAttribute["defaultValue"]) =>
  typeof defaultValue === "function" ? defaultValue() : defaultValue;

const columnName = (attr: ExecutorFieldAttribute, field: string) => attr.columnName ?? field;

const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const run = (db: SqliteDatabase, model: string, query: SQL) =>
  Effect.try({
    try: () => db.run(query),
    catch: (cause) =>
      new StorageQueryError({
        model,
        message: cause instanceof Error ? cause.message : "SQLite query failed",
        cause,
      }),
  });

const all = <T>(db: SqliteDatabase, model: string, query: SQL) =>
  Effect.try({
    try: () => db.all<T>(query),
    catch: (cause) =>
      new StorageQueryError({
        model,
        message: cause instanceof Error ? cause.message : "SQLite query failed",
        cause,
      }),
  });

const get = <T>(db: SqliteDatabase, model: string, query: SQL) =>
  Effect.try({
    try: () => db.get<T | undefined>(query),
    catch: (cause) =>
      new StorageQueryError({
        model,
        message: cause instanceof Error ? cause.message : "SQLite query failed",
        cause,
      }),
  });
