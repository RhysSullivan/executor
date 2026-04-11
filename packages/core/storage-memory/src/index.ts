import { Effect } from "effect";

import {
  type CountArgs,
  type CreateArgs,
  type DeleteArgs,
  type DeleteManyArgs,
  type ExecutorDBSchema,
  type ExecutorFieldAttribute,
  type ExecutorStorage,
  type ExecutorStorageTransaction,
  type FindManyArgs,
  type FindOneArgs,
  type StorageError,
  type StorageCapabilities,
  StorageFieldError,
  StorageQueryError,
  type UpdateArgs,
  type UpdateManyArgs,
  type Where,
  executorCoreSchema,
  getField,
  getModel,
  validateSchemaCapabilities,
} from "@executor/storage";

type Row = Record<string, unknown>;

export interface MemoryStorageOptions {
  readonly schema?: ExecutorDBSchema;
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

export const makeMemoryStorage = (
  options?: MemoryStorageOptions,
): Effect.Effect<ExecutorStorage, StorageError> =>
  Effect.gen(function* () {
    const schema = options?.schema ?? executorCoreSchema;
    yield* validateSchemaCapabilities("memory", capabilities, schema);

    const tables = new Map<string, Row[]>();
    for (const model of Object.keys(schema)) {
      tables.set(model, []);
    }

    const makeStorage = (): ExecutorStorage => {
      const txStorage: ExecutorStorageTransaction = {
        id: "memory",
        capabilities,
        create: (args) => create(schema, tables, args),
        findOne: (args) => findOne(schema, tables, args),
        findMany: (args) => findMany(schema, tables, args),
        update: (args) => update(schema, tables, args),
        updateMany: (args) => updateMany(schema, tables, args),
        delete: (args) => deleteOne(schema, tables, args),
        deleteMany: (args) => deleteMany(schema, tables, args),
        count: (args) => count(schema, tables, args),
      };

      return {
        ...txStorage,
        transaction: (callback) =>
          Effect.gen(function* () {
            const snapshot = cloneTables(tables);
            const result = yield* callback(txStorage).pipe(Effect.either);
            if (result._tag === "Left") {
              restoreTables(tables, snapshot);
              return yield* Effect.fail(result.left);
            }
            return result.right;
          }),
      };
    };

    return makeStorage();
  });

const create = <T>(
  schema: ExecutorDBSchema,
  tables: Map<string, Row[]>,
  args: CreateArgs,
): Effect.Effect<T, StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    const row = yield* materializeRow(model.fields, args.model, args.data);
    const rows = table(tables, args.model);

    if (rows.some((existing) => primaryKeyEquals(model.primaryKey, existing, row))) {
      return yield* new StorageQueryError({
        model: args.model,
        message: `Duplicate primary key for model "${args.model}"`,
      });
    }

    rows.push(row);
    return project(row) as T;
  });

const findOne = <T>(schema: ExecutorDBSchema, tables: Map<string, Row[]>, args: FindOneArgs) =>
  findMany<T>(schema, tables, { ...args, limit: 1 }).pipe(Effect.map((rows) => rows[0] ?? null));

const findMany = <T>(
  schema: ExecutorDBSchema,
  tables: Map<string, Row[]>,
  args: FindManyArgs,
): Effect.Effect<readonly T[], StorageError> =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateWhere(model.fields, args.model, args.where ?? []);
    if (args.sortBy) yield* getField(model, args.sortBy.field);
    if (args.select) {
      for (const field of args.select) yield* getField(model, field);
    }

    let rows = table(tables, args.model).filter((row) => matchesWhere(row, args.where ?? []));
    if (args.sortBy) {
      const { field, direction } = args.sortBy;
      rows = [...rows].sort(
        (a, b) => compareValues(a[field], b[field]) * (direction === "asc" ? 1 : -1),
      );
    }
    const offset = args.offset ?? 0;
    const limited =
      typeof args.limit === "number" ? rows.slice(offset, offset + args.limit) : rows.slice(offset);
    return limited.map((row) => project(row, args.select) as T);
  });

const update = <T>(schema: ExecutorDBSchema, tables: Map<string, Row[]>, args: UpdateArgs) =>
  Effect.gen(function* () {
    const rows = yield* matchingRows(schema, tables, args.model, args.where);
    const row = rows[0];
    if (!row) return null;
    const model = yield* getModel(schema, args.model);
    for (const field of Object.keys(args.update)) yield* getField(model, field);
    Object.assign(row, args.update);
    return project(row) as T;
  });

const updateMany = (schema: ExecutorDBSchema, tables: Map<string, Row[]>, args: UpdateManyArgs) =>
  Effect.gen(function* () {
    const rows = yield* matchingRows(schema, tables, args.model, args.where);
    const model = yield* getModel(schema, args.model);
    for (const field of Object.keys(args.update)) yield* getField(model, field);
    for (const row of rows) Object.assign(row, args.update);
    return rows.length;
  });

const deleteOne = (schema: ExecutorDBSchema, tables: Map<string, Row[]>, args: DeleteArgs) =>
  deleteMany(schema, tables, args).pipe(Effect.map((deleted) => deleted > 0));

const deleteMany = (schema: ExecutorDBSchema, tables: Map<string, Row[]>, args: DeleteManyArgs) =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, args.model);
    yield* validateWhere(model.fields, args.model, args.where);
    const rows = table(tables, args.model);
    const keep = rows.filter((row) => !matchesWhere(row, args.where));
    const deleted = rows.length - keep.length;
    tables.set(args.model, keep);
    return deleted;
  });

const count = (schema: ExecutorDBSchema, tables: Map<string, Row[]>, args: CountArgs) =>
  findMany(schema, tables, { model: args.model, where: args.where }).pipe(
    Effect.map((rows) => rows.length),
  );

const matchingRows = (
  schema: ExecutorDBSchema,
  tables: Map<string, Row[]>,
  modelName: string,
  where: readonly Where[],
) =>
  Effect.gen(function* () {
    const model = yield* getModel(schema, modelName);
    yield* validateWhere(model.fields, modelName, where);
    return table(tables, modelName).filter((row) => matchesWhere(row, where));
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
      const value = data[field] ?? evaluateDefault(attr.defaultValue);
      if (attr.required && (value === undefined || value === null)) {
        return yield* new StorageFieldError({
          model,
          field,
          message: `Missing required field "${field}"`,
        });
      }
      if (value !== undefined) row[field] = cloneValue(value);
    }
    return row;
  });

const validateWhere = (
  fields: Record<string, ExecutorFieldAttribute>,
  model: string,
  where: readonly Where[],
) =>
  Effect.gen(function* () {
    for (const clause of where) {
      if (!fields[clause.field]) {
        return yield* new StorageFieldError({
          model,
          field: clause.field,
          message: `Unknown field "${clause.field}"`,
        });
      }
    }
  });

const matchesWhere = (row: Row, where: readonly Where[]) => {
  if (where.length === 0) return true;
  let result = evalWhere(row, where[0]!);
  for (let i = 1; i < where.length; i += 1) {
    const clause = where[i]!;
    const clauseResult = evalWhere(row, clause);
    result = clause.connector === "OR" ? result || clauseResult : result && clauseResult;
  }
  return result;
};

const evalWhere = (row: Row, clause: Where): boolean => {
  const left = row[clause.field];
  const right = clause.value;
  const operator = clause.operator ?? "eq";

  if (clause.mode === "insensitive") {
    return evalInsensitive(left, right, operator);
  }

  switch (operator) {
    case "eq":
      return compareScalar(left, right) === 0;
    case "ne":
      return compareScalar(left, right) !== 0;
    case "lt":
      return compareScalar(left, right) < 0;
    case "lte":
      return compareScalar(left, right) <= 0;
    case "gt":
      return compareScalar(left, right) > 0;
    case "gte":
      return compareScalar(left, right) >= 0;
    case "in":
      return Array.isArray(right) && right.some((value) => compareScalar(left, value) === 0);
    case "not_in":
      return Array.isArray(right) && right.every((value) => compareScalar(left, value) !== 0);
    case "contains":
      return typeof left === "string" && typeof right === "string" && left.includes(right);
    case "starts_with":
      return typeof left === "string" && typeof right === "string" && left.startsWith(right);
    case "ends_with":
      return typeof left === "string" && typeof right === "string" && left.endsWith(right);
  }
};

const evalInsensitive = (left: unknown, right: unknown, operator: Where["operator"]): boolean => {
  const normalize = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : value);
  const normalizedLeft = normalize(left);
  const normalizedRight = Array.isArray(right) ? right.map(normalize) : normalize(right);
  return evalWhere(
    { value: normalizedLeft },
    { field: "value", operator, value: normalizedRight as Where["value"] },
  );
};

const compareScalar = (left: unknown, right: unknown): number => {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (a === b) return 0;
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
};

const compareValues = (left: unknown, right: unknown) => compareScalar(left, right);

const primaryKeyEquals = (primaryKey: readonly string[], left: Row, right: Row) =>
  primaryKey.every((field) => compareScalar(left[field], right[field]) === 0);

const project = (row: Row, select?: readonly string[]) => {
  const projected = select ? Object.fromEntries(select.map((field) => [field, row[field]])) : row;
  return structuredClone(projected);
};

const table = (tables: Map<string, Row[]>, model: string) => tables.get(model) ?? [];

const evaluateDefault = (defaultValue: ExecutorFieldAttribute["defaultValue"]) =>
  typeof defaultValue === "function" ? defaultValue() : defaultValue;

const cloneValue = (value: unknown) => structuredClone(value);

const cloneTables = (tables: Map<string, Row[]>) =>
  new Map([...tables.entries()].map(([model, rows]) => [model, structuredClone(rows)]));

const restoreTables = (tables: Map<string, Row[]>, snapshot: Map<string, Row[]>) => {
  tables.clear();
  for (const [model, rows] of snapshot) {
    tables.set(model, structuredClone(rows));
  }
};
