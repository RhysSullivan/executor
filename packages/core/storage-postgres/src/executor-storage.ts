import { sql, type SQL } from "drizzle-orm";
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

import type { DrizzleDb } from "./types";

type Row = Record<string, unknown>;

export interface PostgresStorageOptions {
  readonly schema?: ExecutorDBSchema;
  readonly migrate?: boolean;
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

export const makePostgresStorage = (
  db: DrizzleDb,
  options?: PostgresStorageOptions,
): Effect.Effect<ExecutorStorage, StorageError> =>
  Effect.gen(function* () {
    const schema = options?.schema ?? executorCoreSchema;
    yield* validateSchemaCapabilities("postgres", capabilities, schema);
    if (options?.migrate ?? true) {
      yield* migratePostgresStorage(db, schema);
    }
    return makeStorage(db, schema);
  });

export const migratePostgresStorage = (db: DrizzleDb, schema: ExecutorDBSchema) =>
  Effect.gen(function* () {
    for (const model of Object.values(schema)) {
      yield* execute(db, model.modelName, createTableSql(model));
      for (const index of model.indexes ?? []) {
        yield* execute(db, model.modelName, createIndexSql(model, index));
      }
    }
  });

const makeStorage = (db: DrizzleDb, schema: ExecutorDBSchema): ExecutorStorage => {
  const txStorage: ExecutorStorageTransaction = {
    id: "postgres",
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
          yield* execute(db, "transaction", sql`BEGIN`);
          const exit = yield* restore(callback(txStorage)).pipe(Effect.exit);

          if (Exit.isSuccess(exit)) {
            yield* execute(db, "transaction", sql`COMMIT`);
          } else {
            yield* execute(db, "transaction", sql`ROLLBACK`);
          }

          return yield* Exit.matchEffect(exit, {
            onFailure: Effect.failCause,
            onSuccess: Effect.succeed,
          });
        }),
      ),
  };
};

const create = <T>(
  db: DrizzleDb,
  schema: ExecutorDBSchema,
  args: CreateArgs,
): Effect.Effect<T, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    const row = yield* materializeRow(model.fields, args.model, args.data);
    const columns = Object.keys(model.fields);
    const inserted = yield* rows<Row>(
      db,
      args.model,
      sql`
      INSERT INTO ${sql.identifier(model.tableName)}
      (${sql.join(
        columns.map((field) => sql.identifier(columnName(model.fields[field]!, field))),
        sql`, `,
      )})
      VALUES (${sql.join(
        columns.map((field) => driverValueSql(model.fields[field]!, row[field])),
        sql`, `,
      )})
      RETURNING ${selectColumnsSql(model)}
    `,
    );
    return fromDriverRow(model, inserted[0] ?? row) as T;
  });

const findOne = <T>(db: DrizzleDb, schema: ExecutorDBSchema, args: FindOneArgs) =>
  findMany<T>(db, schema, { ...args, limit: 1 }).pipe(Effect.map((items) => items[0] ?? null));

const findMany = <T>(
  db: DrizzleDb,
  schema: ExecutorDBSchema,
  args: FindManyArgs,
): Effect.Effect<readonly T[], StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where ?? [], args.sortBy?.field, args.select);
    const found = yield* rows<Row>(
      db,
      args.model,
      selectSql(model, args.where ?? [], args.select, args.sortBy, args.limit, args.offset),
    );
    return found.map((row) => fromDriverRow(model, row, args.select) as T);
  });

const update = <T>(
  db: DrizzleDb,
  schema: ExecutorDBSchema,
  args: UpdateArgs,
): Effect.Effect<T | null, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where, undefined, undefined);
    const updateFields = Object.keys(args.update);
    for (const field of updateFields) yield* getField(model, field);
    const updated = yield* rows<Row>(
      db,
      args.model,
      updateSql(model, updateFields, args.update, args.where, 1),
    );
    return updated[0] ? (fromDriverRow(model, updated[0]) as T) : null;
  });

const updateMany = (
  db: DrizzleDb,
  schema: ExecutorDBSchema,
  args: UpdateManyArgs,
): Effect.Effect<number, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where, undefined, undefined);
    const updateFields = Object.keys(args.update);
    for (const field of updateFields) yield* getField(model, field);
    const updated = yield* rows<Row>(
      db,
      args.model,
      updateSql(model, updateFields, args.update, args.where),
    );
    return updated.length;
  });

const deleteOne = (
  db: DrizzleDb,
  schema: ExecutorDBSchema,
  args: DeleteArgs,
): Effect.Effect<boolean, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where, undefined, undefined);
    const deleted = yield* rows<Row>(db, args.model, deleteSql(model, args.where, 1));
    return deleted.length > 0;
  });

const deleteMany = (
  db: DrizzleDb,
  schema: ExecutorDBSchema,
  args: DeleteManyArgs,
): Effect.Effect<number, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where, undefined, undefined);
    const deleted = yield* rows<Row>(db, args.model, deleteSql(model, args.where));
    return deleted.length;
  });

const count = (
  db: DrizzleDb,
  schema: ExecutorDBSchema,
  args: CountArgs,
): Effect.Effect<number, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateQuery(model, args.where ?? [], undefined, undefined);
    const counted = yield* rows<{ count: string | number }>(
      db,
      args.model,
      sql`
      SELECT COUNT(*) AS count
      FROM ${sql.identifier(model.tableName)}
      ${whereSql(model, args.where ?? [])}
    `,
    );
    return Number(counted[0]?.count ?? 0);
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

const updateSql = (
  model: ExecutorModelSchema,
  updateFields: readonly string[],
  update: Record<string, unknown>,
  where: readonly Where[],
  limit?: number,
) => {
  const filtered = whereSql(model, where);
  const limitFilter =
    typeof limit === "number"
      ? sql`ctid IN (SELECT ctid FROM ${sql.identifier(model.tableName)} ${filtered} LIMIT ${limit})`
      : undefined;
  return sql`
    UPDATE ${sql.identifier(model.tableName)}
    SET ${setSql(model, updateFields, update)}
    ${limitFilter ? sql`WHERE ${limitFilter}` : filtered}
    RETURNING ${selectColumnsSql(model)}
  `;
};

const deleteSql = (model: ExecutorModelSchema, where: readonly Where[], limit?: number) => {
  const filtered = whereSql(model, where);
  const limitFilter =
    typeof limit === "number"
      ? sql`ctid IN (SELECT ctid FROM ${sql.identifier(model.tableName)} ${filtered} LIMIT ${limit})`
      : undefined;
  return sql`
    DELETE FROM ${sql.identifier(model.tableName)}
    ${limitFilter ? sql`WHERE ${limitFilter}` : filtered}
    RETURNING 1
  `;
};

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
      return sql`${sql.identifier(columnName(attr, field))} = ${driverValueSql(attr, update[field])}`;
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
      return insensitive
        ? sql`${column} ILIKE ${`%${String(comparableValue)}%`}`
        : sql`${column} LIKE ${`%${String(comparableValue)}%`}`;
    case "starts_with":
      return insensitive
        ? sql`${column} ILIKE ${`${String(comparableValue)}%`}`
        : sql`${column} LIKE ${`${String(comparableValue)}%`}`;
    case "ends_with":
      return insensitive
        ? sql`${column} ILIKE ${`%${String(comparableValue)}`}`
        : sql`${column} LIKE ${`%${String(comparableValue)}`}`;
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
    const constraints = [quoteIdentifier(columnName(attr, field)), postgresType(attr.type)];
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

const postgresType = (type: ExecutorFieldType) => {
  switch (type) {
    case "string":
      return "TEXT";
    case "number":
      return "DOUBLE PRECISION";
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "TIMESTAMPTZ";
    case "json":
    case "string[]":
    case "number[]":
      return "JSONB";
    case "bytes":
      return "BYTEA";
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
    case "date":
      return value instanceof Date ? value : new Date(Number(value));
    default:
      return value;
  }
};

const fromDriverValue = (attr: ExecutorFieldAttribute, value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  if (attr.type === "date" && !(value instanceof Date)) return new Date(String(value));
  if (
    (attr.type === "json" || attr.type === "string[]" || attr.type === "number[]") &&
    typeof value === "string"
  ) {
    return JSON.parse(value);
  }
  return value;
};

const driverValueSql = (attr: ExecutorFieldAttribute, value: unknown) => {
  if (value === undefined || value === null) return sql`${null}`;
  if (attr.type === "json" || attr.type === "string[]" || attr.type === "number[]") {
    return sql`${JSON.stringify(value)}::jsonb`;
  }
  return sql`${toDriverValue(attr, value)}`;
};

const evaluateDefault = (defaultValue: ExecutorFieldAttribute["defaultValue"]) =>
  typeof defaultValue === "function" ? defaultValue() : defaultValue;

const columnName = (attr: ExecutorFieldAttribute, field: string) => attr.columnName ?? field;

const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const execute = (db: DrizzleDb, model: string, query: SQL) =>
  Effect.tryPromise({
    try: () => db.execute(query),
    catch: (cause) =>
      new StorageQueryError({
        model,
        message: cause instanceof Error ? cause.message : "Postgres query failed",
        cause,
      }),
  });

const rows = <T>(db: DrizzleDb, model: string, query: SQL) =>
  execute(db, model, query).pipe(Effect.map((result) => resultRows<T>(result)));

const resultRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
};
