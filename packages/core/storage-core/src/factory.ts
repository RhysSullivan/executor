// ---------------------------------------------------------------------------
// createAdapter — factory that wraps a CustomAdapter into a DBAdapter.
//
// Vendored from better-auth (packages/core/src/db/adapter/factory.ts) under
// MIT. Adapted for executor:
//   - Promise/async → Effect.Effect<T, StorageFailure>
//   - Stripped auth-specific concerns (numeric serial ids, joins, telemetry
//     spans, logger, plural model name resolution, BetterAuthOptions)
//   - Contract matches our CustomAdapter + DBAdapterFactoryConfig in
//     ./adapter.ts (simpler than better-auth's equivalents)
//
// Responsibilities:
//   - id generation (auto + customIdGenerator + forceAllowId)
//   - transformInput: apply defaultValue / onUpdate / transform.input,
//     map logical field names → physical column names, serialize JSON /
//     dates / booleans / arrays based on supports* flags
//   - transformOutput: map physical column names → logical field names,
//     deserialize JSON / dates / booleans / arrays, apply transform.output,
//     filter by `returned: false`
//   - transformWhereClause: fill in CleanedWhere defaults, rename field,
//     re-encode RHS to match the write path
//   - createMany fallback: loop create when the CustomAdapter doesn't
//     implement it natively
//   - transaction: delegate to config.transaction when provided; fall back
//     to running the callback against the current adapter
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import type {
  CleanedWhere,
  CustomAdapter,
  DBAdapter,
  DBAdapterFactoryConfig,
  DBTransactionAdapter,
  JoinConfig,
  JoinOption,
  StorageFailure,
  Where,
} from "./adapter";
import { StorageError } from "./errors";
import type { DBFieldAttribute, DBSchema, DBPrimitive } from "./schema";

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

const defaultGenerateId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Default value helpers — mirrors better-auth's `withApplyDefault`.
// ---------------------------------------------------------------------------

const withApplyDefault = (
  value: unknown,
  field: DBFieldAttribute,
  action: "create" | "update",
): unknown => {
  if (action === "update") {
    // Only apply onUpdate when the caller DID NOT supply a value. An explicit
    // `updatedAt: someDate` in the update payload should win over the
    // plugin's onUpdate hook — matches upstream.
    if (value === undefined && field.onUpdate !== undefined) {
      return field.onUpdate();
    }
    return value;
  }
  // Create: apply defaultValue only when the caller omitted the field, OR
  // when they passed null for a required field (upstream convention —
  // explicit null on an optional/nullable field is preserved). Without the
  // `required` gate we'd silently overwrite legitimate null writes.
  const triggerDefault =
    value === undefined || (field.required === true && value === null);
  if (triggerDefault && field.defaultValue !== undefined) {
    return typeof field.defaultValue === "function"
      ? (field.defaultValue as () => DBPrimitive)()
      : field.defaultValue;
  }
  return value;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateAdapterOptions {
  readonly schema: DBSchema;
  readonly config: DBAdapterFactoryConfig;
  readonly adapter: CustomAdapter;
}

/**
 * Wrap a CustomAdapter into a full DBAdapter that applies schema-driven
 * transforms. This is the single codepath every backend shares.
 */
export const createAdapter = (
  options: CreateAdapterOptions,
): DBAdapter => {
  const { schema, adapter: inner } = options;
  const config: Required<
    Pick<
      DBAdapterFactoryConfig,
      | "adapterId"
      | "supportsJSON"
      | "supportsDates"
      | "supportsBooleans"
      | "supportsArrays"
      | "disableIdGeneration"
    >
  > & DBAdapterFactoryConfig = {
    ...options.config,
    supportsJSON: options.config.supportsJSON ?? false,
    supportsDates: options.config.supportsDates ?? true,
    supportsBooleans: options.config.supportsBooleans ?? true,
    supportsArrays: options.config.supportsArrays ?? false,
    disableIdGeneration: options.config.disableIdGeneration ?? false,
  };

  const idGen = (model: string): string => {
    if (config.customIdGenerator) {
      return config.customIdGenerator({ model });
    }
    return defaultGenerateId();
  };

  const getModelDef = (
    model: string,
  ): Effect.Effect<DBSchema[string], StorageError> =>
    Effect.gen(function* () {
      const def = schema[model];
      if (!def) {
        return yield* Effect.fail(
          new StorageError({
            message: `[storage-core] unknown model "${model}"`,
            cause: undefined,
          }),
        );
      }
      return def;
    });

  // Sync accessor for call sites that can't sit inside Effect.gen (cleanWhere,
  // getModelName, getPhysicalField). These are all fed model names that have
  // already been validated upstream by the typed API, so unknown-model throws
  // here are a caller bug, not a runtime failure channel.
  const getModelDefSync = (model: string): DBSchema[string] => {
    const def = schema[model];
    if (!def) throw new Error(`[storage-core] unknown model "${model}"`);
    return def;
  };

  // Map physical table name → logical model key, for renaming incoming model
  // arg in mapKeysTransformInput/Output when callers pass physical names.
  // We deliberately *don't* support plural or physical-name inputs — our
  // plugins always pass the logical key — so getModelName is identity.
  const getModelName = (model: string): string =>
    getModelDefSync(model).modelName ?? model;

  // Field name (logical → physical). Honors mapKeysTransformInput override.
  const getPhysicalField = (model: string, logical: string): string => {
    if (logical === "id") return config.mapKeysTransformInput?.["id"] ?? "id";
    const override = config.mapKeysTransformInput?.[logical];
    if (override) return override;
    const attr = getModelDefSync(model).fields[logical];
    return attr?.fieldName ?? logical;
  };

  // Inverse of mapKeysTransformOutput: on the output path we may need to
  // rename a logical field to a different output key for the caller (symmetric
  // to mapKeysTransformInput on the write path). Upstream better-auth wires
  // this in the same place.
  const getOutputKey = (logical: string): string =>
    config.mapKeysTransformOutput?.[logical] ?? logical;

  // ---------------------------------------------------------------------------
  // Value encode / decode based on supports* flags.
  // ---------------------------------------------------------------------------

  const encodeValue = (
    attr: DBFieldAttribute | undefined,
    value: unknown,
  ): unknown => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!attr) return value;
    const type = attr.type;
    if (type === "json") {
      if (!config.supportsJSON) return JSON.stringify(value);
      return value;
    }
    if (type === "date") {
      if (value instanceof Date) {
        return config.supportsDates ? value : value.toISOString();
      }
      if (typeof value === "string" && !config.supportsDates) {
        // Keep ISO strings as-is
        return value;
      }
      return value;
    }
    if (type === "boolean") {
      if (config.supportsBooleans) return value;
      return value ? 1 : 0;
    }
    if (
      (type === "string[]" || type === "number[]") &&
      Array.isArray(value) &&
      !config.supportsArrays
    ) {
      return JSON.stringify(value);
    }
    return value;
  };

  const decodeValue = (
    attr: DBFieldAttribute | undefined,
    value: unknown,
  ): unknown => {
    if (value === undefined || value === null) return value;
    if (!attr) return value;
    const type = attr.type;
    if (type === "json" && typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    if (type === "date") {
      if (value instanceof Date) return value;
      if (typeof value === "string" || typeof value === "number") {
        return new Date(value);
      }
      return value;
    }
    if (type === "boolean" && typeof value === "number") {
      return value === 1;
    }
    if (
      (type === "string[]" || type === "number[]") &&
      typeof value === "string"
    ) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    if (type === "number" && typeof value === "string") {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    return value;
  };

  // ---------------------------------------------------------------------------
  // transformInput — logical row → physical row, with defaults + id gen
  // ---------------------------------------------------------------------------

  const transformInput = (
    model: string,
    data: Record<string, unknown>,
    action: "create" | "update",
    forceAllowId: boolean,
  ): Effect.Effect<Record<string, unknown>, StorageFailure> =>
    Effect.gen(function* () {
      const def = yield* getModelDef(model);
      const out: Record<string, unknown> = {};

      // id handling on create
      if (action === "create") {
        if (forceAllowId && "id" in data && data.id !== undefined && data.id !== null) {
          out[getPhysicalField(model, "id")] = data.id;
        } else if (!config.disableIdGeneration) {
          out[getPhysicalField(model, "id")] = idGen(model);
        }
      }

      for (const [logical, attr] of Object.entries(def.fields)) {
        if (logical === "id") continue;
        if (attr.input === false) continue;
        let value: unknown = data[logical];

        // Date coercion from string
        if (
          attr.type === "date" &&
          value !== undefined &&
          value !== null &&
          !(value instanceof Date) &&
          typeof value === "string"
        ) {
          try {
            value = new Date(value);
          } catch {
            // leave as-is
          }
        }

        // defaultValue / onUpdate
        value = withApplyDefault(value, attr, action);

        // transform.input
        if (attr.transform?.input) {
          const res = attr.transform.input(value as DBPrimitive);
          // Sync only in executor path; if a plugin returns a Promise we
          // await it via tryPromise to keep the Effect pure.
          if (res && typeof (res as { then?: unknown }).then === "function") {
            value = yield* Effect.tryPromise({
              try: () => res as Promise<DBPrimitive>,
              catch: (cause) =>
                new StorageError({
                  message: `[storage-core] transform.input for "${model}.${logical}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                  cause,
                }),
            });
          } else {
            value = res;
          }
        }

        if (value === undefined) continue;

        const physical = getPhysicalField(model, logical);
        let encoded = encodeValue(attr, value);

        // customTransformInput — user-land per-field hook, runs after the
        // built-in encode step. Effect-ified from upstream's sync `any`
        // return — plugins that don't need async work can wrap with
        // `Effect.succeed`.
        if (config.customTransformInput) {
          encoded = yield* config.customTransformInput({
            data: encoded,
            fieldAttributes: attr,
            field: physical,
            action,
            model: getModelName(model),
            schema,
          });
        }

        out[physical] = encoded;
      }

      return out;
    });

  // ---------------------------------------------------------------------------
  // transformOutput — physical row → logical row, filter `returned: false`
  // ---------------------------------------------------------------------------

  const transformOutput = (
    model: string,
    row: Record<string, unknown> | null,
    select?: string[],
  ): Effect.Effect<Record<string, unknown> | null, StorageFailure> =>
    Effect.gen(function* () {
      if (row === null || row === undefined) return null;
      const def = yield* getModelDef(model);
      const out: Record<string, unknown> = {};

      // id always returned
      const idPhysical = getPhysicalField(model, "id");
      const idOutputKey = getOutputKey("id");
      if (idPhysical in row && row[idPhysical] !== undefined) {
        out[idOutputKey] = row[idPhysical];
      } else if ("id" in row) {
        out[idOutputKey] = row["id"];
      }

      for (const [logical, attr] of Object.entries(def.fields)) {
        if (logical === "id") continue;
        if (attr.returned === false) continue;
        if (select && select.length > 0 && !select.includes(logical)) continue;

        const physical = getPhysicalField(model, logical);
        if (!(physical in row)) continue;

        let value: unknown = decodeValue(attr, row[physical]);

        if (attr.transform?.output) {
          const res = attr.transform.output(value as DBPrimitive);
          if (res && typeof (res as { then?: unknown }).then === "function") {
            value = yield* Effect.tryPromise({
              try: () => res as Promise<DBPrimitive>,
              catch: (cause) =>
                new StorageError({
                  message: `[storage-core] transform.output for "${model}.${logical}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                  cause,
                }),
            });
          } else {
            value = res;
          }
        }

        // customTransformOutput — user-land per-field hook, runs after the
        // built-in decode step. Mirrors upstream threading.
        if (config.customTransformOutput) {
          value = yield* config.customTransformOutput({
            data: value,
            fieldAttributes: attr,
            field: logical,
            select: select ?? [],
            model: getModelName(model),
            schema,
          });
        }

        out[getOutputKey(logical)] = value;
      }
      return out;
    });

  // ---------------------------------------------------------------------------
  // transformWhereClause — Where[] → CleanedWhere[]
  //
  // Fills in defaults, renames logical → physical, re-encodes RHS so that
  // filter comparisons line up with the wire representation produced by
  // transformInput.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Join resolver — JoinOption (caller) → JoinConfig (custom adapter)
  //
  // For each requested join target `T` (keyed by logical model name), we
  // look at both sides of the schema:
  //
  //   - If the *base* model has a field whose `references.model === T`,
  //     this is a "child → parent" lookup: relation = one-to-one,
  //     `on.from` = the base field, `on.to` = the referenced field on T.
  //   - Otherwise, if model T has a field whose `references.model === base`,
  //     this is a "parent → children" lookup: relation = one-to-many,
  //     `on.from` = the referenced field on base (usually "id"),
  //     `on.to` = the field on T carrying the FK.
  //
  // If neither side declares a reference we throw — a caller asking for a
  // join that the schema can't resolve is a bug, not a runtime state.
  // ---------------------------------------------------------------------------

  const resolveJoin = (base: string, join: JoinOption): JoinConfig => {
    const baseDef = getModelDefSync(base);
    const out: JoinConfig = {};
    for (const [target, raw] of Object.entries(join)) {
      if (raw === false) continue;
      const targetDef = getModelDefSync(target);
      const limit =
        typeof raw === "object" && raw.limit !== undefined ? raw.limit : undefined;

      // child → parent
      let found: JoinConfig[string] | undefined;
      for (const [fieldName, attr] of Object.entries(baseDef.fields)) {
        if (attr.references?.model === target) {
          found = {
            on: {
              from: getPhysicalField(base, fieldName),
              to:
                getPhysicalField(target, attr.references.field) ||
                attr.references.field,
            },
            relation: "one-to-one",
            ...(limit !== undefined ? { limit } : {}),
          };
          break;
        }
      }
      // parent → children
      if (!found) {
        for (const [fieldName, attr] of Object.entries(targetDef.fields)) {
          if (attr.references?.model === base) {
            found = {
              on: {
                from:
                  getPhysicalField(base, attr.references.field) ||
                  attr.references.field,
                to: getPhysicalField(target, fieldName),
              },
              relation: "one-to-many",
              ...(limit !== undefined ? { limit } : {}),
            };
            break;
          }
        }
      }
      if (!found) {
        throw new Error(
          `[storage-core] cannot resolve join "${base}" → "${target}": neither model declares a \`references\` for the other`,
        );
      }
      out[target] = found;
    }
    return out;
  };

  const cleanWhere = (
    model: string,
    where: readonly Where[] | undefined,
  ): CleanedWhere[] | undefined => {
    if (!where) return undefined;
    const def = getModelDefSync(model);
    return where.map((w) => {
      const operator = w.operator ?? "eq";
      const connector = w.connector ?? "AND";
      const mode = w.mode ?? "sensitive";
      const logical = w.field;
      const attr =
        logical === "id" ? undefined : def.fields[logical];
      const physical = getPhysicalField(model, logical);

      let value: Where["value"] = w.value;
      if (attr) {
        if (Array.isArray(value)) {
          value = (value as unknown[]).map((v) =>
            encodeValue(attr, v),
          ) as typeof value;
        } else {
          value = encodeValue(attr, value) as typeof value;
        }
      }

      return {
        operator,
        connector,
        mode,
        field: physical,
        value,
      } satisfies CleanedWhere;
    });
  };

  // ---------------------------------------------------------------------------
  // Transform skip helpers — disableTransformInput/Output let backend authors
  // bypass the factory's built-in transform when they want the raw shape
  // passed through. Matches upstream's `if (!config.disableTransform*)`.
  // ---------------------------------------------------------------------------

  const maybeTransformInput = (
    model: string,
    data: Record<string, unknown>,
    action: "create" | "update",
    forceAllowId: boolean,
  ): Effect.Effect<Record<string, unknown>, StorageFailure> =>
    config.disableTransformInput
      ? Effect.succeed(data)
      : transformInput(model, data, action, forceAllowId);

  // ---------------------------------------------------------------------------
  // attachJoinedRows — re-decode nested join payloads.
  //
  // `transformOutput` only knows about the base model's fields and drops
  // anything else. If the caller asked for `join: { tag: true }` we need
  // to run the nested rows through `transformOutput` keyed on the target
  // model and then stick the decoded payload onto the base row under the
  // logical join key. Mirrors the upstream factory's nested-result path.
  // ---------------------------------------------------------------------------

  const attachJoinedRows = (
    base: Record<string, unknown> | null,
    raw: Record<string, unknown> | null,
    join: JoinOption | undefined,
  ): Effect.Effect<Record<string, unknown> | null, StorageFailure> =>
    Effect.gen(function* () {
      if (!base || !raw || !join) return base;
      const merged: Record<string, unknown> = { ...base };
      for (const [target, flag] of Object.entries(join)) {
        if (flag === false) continue;
        const nested = raw[target];
        if (nested === undefined) continue;
        if (nested === null) {
          merged[target] = null;
          continue;
        }
        if (Array.isArray(nested)) {
          const decoded: unknown[] = [];
          for (const n of nested) {
            if (n && typeof n === "object") {
              const t = yield* transformOutput(
                target,
                n as Record<string, unknown>,
              );
              decoded.push(t);
            } else {
              decoded.push(n);
            }
          }
          merged[target] = decoded;
        } else if (typeof nested === "object") {
          merged[target] = yield* transformOutput(
            target,
            nested as Record<string, unknown>,
          );
        } else {
          merged[target] = nested;
        }
      }
      return merged;
    });

  const maybeTransformOutput = (
    model: string,
    row: Record<string, unknown> | null,
    select?: string[],
  ): Effect.Effect<Record<string, unknown> | null, StorageFailure> =>
    config.disableTransformOutput
      ? Effect.succeed(row)
      : transformOutput(model, row, select);

  // ---------------------------------------------------------------------------
  // DBAdapter surface
  // ---------------------------------------------------------------------------

  const self: DBAdapter = {
    id: config.adapterId,

    create: <T extends Record<string, unknown>, R = T>(data: {
      model: string;
      data: Omit<T, "id">;
      select?: string[] | undefined;
      forceAllowId?: boolean | undefined;
    }) =>
      Effect.gen(function* () {
        const input = yield* maybeTransformInput(
          data.model,
          data.data as Record<string, unknown>,
          "create",
          data.forceAllowId === true,
        );
        const res = yield* inner.create({
          model: getModelName(data.model),
          data: input,
          select: data.select,
        });
        const out = yield* maybeTransformOutput(
          data.model,
          res as Record<string, unknown>,
          data.select,
        );
        return out as unknown as R;
      }).pipe(
        Effect.withSpan("executor.storage.create", {
          attributes: {
            "executor.storage.adapter_id": config.adapterId,
            "executor.storage.table": data.model,
          },
        }),
      ),

    createMany: <T extends Record<string, unknown>, R = T>(data: {
      model: string;
      data: ReadonlyArray<Omit<T, "id">>;
      forceAllowId?: boolean | undefined;
    }) =>
      Effect.gen(function* () {
        // Delegates straight to the backend's native bulk insert — no
        // per-row fallback, because over a real network connection
        // (Hyperdrive, etc.) N round-trips would blow the request
        // budget for specs with thousands of operations. Transforms
        // still run per-row so JSON / dates / booleans serialize the
        // same as single `create`.
        const inputs: Record<string, unknown>[] = [];
        for (const row of data.data) {
          inputs.push(
            yield* maybeTransformInput(
              data.model,
              row as Record<string, unknown>,
              "create",
              data.forceAllowId === true,
            ),
          );
        }
        const res = yield* inner.createMany({
          model: getModelName(data.model),
          data: inputs,
        });
        const out: R[] = [];
        for (const row of res) {
          out.push(
            (yield* maybeTransformOutput(
              data.model,
              row as Record<string, unknown>,
              undefined,
            )) as unknown as R,
          );
        }
        return out as unknown as readonly R[];
      }).pipe(
        Effect.withSpan("executor.storage.create_many", {
          attributes: {
            "executor.storage.adapter_id": config.adapterId,
            "executor.storage.table": data.model,
            "executor.storage.row_count": data.data.length,
          },
        }),
      ),

    findOne: <T>(data: {
      model: string;
      where: Where[];
      select?: string[] | undefined;
      join?: JoinOption | undefined;
    }) =>
      Effect.gen(function* () {
        const where = cleanWhere(data.model, data.where) ?? [];
        const join = data.join ? resolveJoin(data.model, data.join) : undefined;
        const res = yield* inner.findOne<Record<string, unknown>>({
          model: getModelName(data.model),
          where,
          select: data.select,
          join,
        });
        const out = yield* maybeTransformOutput(data.model, res, data.select);
        const merged = yield* attachJoinedRows(out, res, data.join);
        return merged as unknown as T | null;
      }).pipe(
        Effect.withSpan("executor.storage.find_one", {
          attributes: {
            "executor.storage.adapter_id": config.adapterId,
            "executor.storage.table": data.model,
          },
        }),
      ),

    findMany: <T>(data: {
      model: string;
      where?: Where[] | undefined;
      limit?: number | undefined;
      select?: string[] | undefined;
      sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
      offset?: number | undefined;
      join?: JoinOption | undefined;
    }) =>
      Effect.gen(function* () {
        const where = cleanWhere(data.model, data.where);
        const sortBy = data.sortBy
          ? {
              field: getPhysicalField(data.model, data.sortBy.field),
              direction: data.sortBy.direction,
            }
          : undefined;
        const join = data.join ? resolveJoin(data.model, data.join) : undefined;
        const res = yield* inner.findMany<Record<string, unknown>>({
          model: getModelName(data.model),
          where,
          limit: data.limit,
          select: data.select,
          sortBy,
          offset: data.offset,
          join,
        });
        const out: unknown[] = [];
        for (const r of res) {
          const t = yield* maybeTransformOutput(data.model, r, data.select);
          const merged = yield* attachJoinedRows(t, r, data.join);
          out.push(merged);
        }
        return out as readonly T[];
      }).pipe(
        Effect.withSpan("executor.storage.find_many", {
          attributes: {
            "executor.storage.adapter_id": config.adapterId,
            "executor.storage.table": data.model,
          },
        }),
      ),

    count: (data: { model: string; where?: Where[] | undefined }) =>
      Effect.gen(function* () {
        const where = cleanWhere(data.model, data.where);
        return yield* inner.count({
          model: getModelName(data.model),
          where,
        });
      }).pipe(
        Effect.withSpan("executor.storage.count", {
          attributes: {
            "executor.storage.adapter_id": config.adapterId,
            "executor.storage.table": data.model,
          },
        }),
      ),

    update: <T>(data: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }) =>
      Effect.gen(function* () {
        const where = cleanWhere(data.model, data.where) ?? [];
        const update = yield* maybeTransformInput(
          data.model,
          data.update,
          "update",
          false,
        );
        const res = yield* inner.update<Record<string, unknown>>({
          model: getModelName(data.model),
          where,
          update,
        });
        const out = yield* maybeTransformOutput(data.model, res);
        return out as unknown as T | null;
      }).pipe(
        Effect.withSpan("executor.storage.update", {
          attributes: {
            "executor.storage.adapter_id": config.adapterId,
            "executor.storage.table": data.model,
          },
        }),
      ),

    updateMany: (data: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }) =>
      Effect.gen(function* () {
        const where = cleanWhere(data.model, data.where) ?? [];
        const update = yield* maybeTransformInput(
          data.model,
          data.update,
          "update",
          false,
        );
        return yield* inner.updateMany({
          model: getModelName(data.model),
          where,
          update,
        });
      }).pipe(
        Effect.withSpan("executor.storage.update_many", {
          attributes: {
            "executor.storage.adapter_id": config.adapterId,
            "executor.storage.table": data.model,
          },
        }),
      ),

    delete: (data: { model: string; where: Where[] }) =>
      Effect.gen(function* () {
        const where = cleanWhere(data.model, data.where) ?? [];
        yield* inner.delete({
          model: getModelName(data.model),
          where,
        });
      }).pipe(
        Effect.withSpan("executor.storage.delete", {
          attributes: {
            "executor.storage.adapter_id": config.adapterId,
            "executor.storage.table": data.model,
          },
        }),
      ),

    deleteMany: (data: { model: string; where: Where[] }) =>
      Effect.gen(function* () {
        const where = cleanWhere(data.model, data.where) ?? [];
        return yield* inner.deleteMany({
          model: getModelName(data.model),
          where,
        });
      }).pipe(
        Effect.withSpan("executor.storage.delete_many", {
          attributes: {
            "executor.storage.adapter_id": config.adapterId,
            "executor.storage.table": data.model,
          },
        }),
      ),

    transaction: <R, E>(
      callback: (trx: DBTransactionAdapter) => Effect.Effect<R, E>,
    ) => {
      const txFn = config.transaction;
      const ran = !txFn ? callback(self) : txFn(callback);
      return ran.pipe(
        Effect.withSpan("executor.storage.transaction", {
          attributes: {
            "executor.storage.adapter_id": config.adapterId,
            "executor.storage.transaction.native": txFn !== undefined,
          },
        }),
      );
    },

    // Forward the backend's createSchema verbatim. Upstream better-auth
    // mutates the `tables` set here to drop session when secondaryStorage
    // is set; we intentionally don't replicate that auth-specific concern.
    createSchema: inner.createSchema
      ? (props) => inner.createSchema!(props)
      : undefined,

    // Expose the full factory config + the inner adapter's own options to
    // plugin authors at runtime. Mirrors upstream's `options` field on
    // DBAdapter.
    options: {
      adapterConfig: options.config,
      ...(inner.options ?? {}),
    },
  };

  return self;
};
