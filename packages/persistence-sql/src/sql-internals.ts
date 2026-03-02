import { drizzle as drizzlePgProxy } from "drizzle-orm/pg-proxy";
import { migrate as migratePgProxy } from "drizzle-orm/pg-proxy/migrator";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { migrate as migrateSqliteProxy } from "drizzle-orm/sqlite-proxy/migrator";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import postgres, { type Sql } from "postgres";

import {
  approvalsTable as approvalsSqliteTable,
  authConnectionsTable as authConnectionsSqliteTable,
  authMaterialsTable as authMaterialsSqliteTable,
  oauthStatesTable as oauthStatesSqliteTable,
  organizationMembershipsTable as organizationMembershipsSqliteTable,
  organizationsTable as organizationsSqliteTable,
  policiesTable as policiesSqliteTable,
  profileTable as profileSqliteTable,
  sourceAuthBindingsTable as sourceAuthBindingsSqliteTable,
  sourcesTable as sourcesSqliteTable,
  storageInstancesTable as storageInstancesSqliteTable,
  syncStatesTable as syncStatesSqliteTable,
  taskRunsTable as taskRunsSqliteTable,
  toolArtifactsTable as toolArtifactsSqliteTable,
  workspacesTable as workspacesSqliteTable,
} from "./schema";

export type SqlBackend = "sqlite" | "postgres";
type SqlRow = Record<string, unknown>;

export type SqlAdapter = {
  readonly backend: SqlBackend;
  query: <TRow extends SqlRow = SqlRow>(
    statement: string,
    args?: ReadonlyArray<unknown>,
  ) => Promise<Array<TRow>>;
  execute: (statement: string, args?: ReadonlyArray<unknown>) => Promise<void>;
  transaction: <A>(run: (transaction: SqlAdapter) => Promise<A>) => Promise<A>;
  close: () => Promise<void>;
};

type SqliteStatement = {
  all: (...parameters: Array<unknown>) => Array<SqlRow>;
  run: (...parameters: Array<unknown>) => unknown;
};

type GenericSqliteDatabase = {
  exec: (statement: string) => void;
  prepare: (statement: string) => SqliteStatement;
  close: (...parameters: Array<unknown>) => void;
};

type NodeSqliteModule = {
  DatabaseSync: new (filename: string) => GenericSqliteDatabase;
};

type BunSqliteQuery = {
  all: (...parameters: Array<unknown>) => Array<SqlRow>;
  run: (...parameters: Array<unknown>) => unknown;
};

type BunSqliteDatabase = {
  query: (statement: string) => BunSqliteQuery;
  exec: (statement: string) => void;
  close: (...parameters: Array<unknown>) => void;
};

type BunSqliteModule = {
  Database: new (
    filename: string,
    options?: {
      create?: boolean;
      readonly?: boolean;
    },
  ) => BunSqliteDatabase;
};

const withPostgresPlaceholders = (statement: string): string => {
  let index = 0;
  return statement.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
};

const isBunRuntime = (): boolean =>
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

const loadNodeSqliteModule = async (): Promise<NodeSqliteModule> => {
  const moduleSpecifier = "node:sqlite";
  return (await import(moduleSpecifier)) as NodeSqliteModule;
};

const loadBunSqliteModule = async (): Promise<BunSqliteModule> => {
  const moduleSpecifier = "bun:sqlite";
  return (await import(moduleSpecifier)) as BunSqliteModule;
};

const makeSqliteTransaction = (
  execute: (statement: string, args?: ReadonlyArray<unknown>) => Promise<void>,
  query: <TRow extends SqlRow = SqlRow>(
    statement: string,
    args?: ReadonlyArray<unknown>,
  ) => Promise<Array<TRow>>,
): SqlAdapter["transaction"] =>
  async <A>(run: (transactionAdapter: SqlAdapter) => Promise<A>): Promise<A> => {
    await execute("BEGIN IMMEDIATE");

    try {
      const adapter: SqlAdapter = {
        backend: "sqlite",
        query,
        execute,
        transaction: async (nestedRun) => nestedRun(adapter),
        close: async () => {},
      };

      const result = await run(adapter);
      await execute("COMMIT");
      return result;
    } catch (error) {
      try {
        await execute("ROLLBACK");
      } catch {
        // ignore rollback failure after original error
      }

      throw error;
    }
  };

const createNodeSqliteAdapter = async (
  sqlitePath: string,
): Promise<SqlAdapter> => {
  const { DatabaseSync } = await loadNodeSqliteModule();
  const db = new DatabaseSync(sqlitePath);

  const query = async <TRow extends SqlRow = SqlRow>(
    statement: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<Array<TRow>> => {
    const prepared = db.prepare(statement);
    return prepared.all(...args) as Array<TRow>;
  };

  const execute = async (
    statement: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<void> => {
    if (args.length === 0) {
      db.exec(statement);
      return;
    }

    const prepared = db.prepare(statement);
    prepared.run(...args);
  };

  return {
    backend: "sqlite",
    query,
    execute,
    transaction: makeSqliteTransaction(execute, query),
    close: async () => {
      db.close();
    },
  };
};

const createBunSqliteAdapter = async (
  sqlitePath: string,
): Promise<SqlAdapter> => {
  const { Database } = await loadBunSqliteModule();
  const db = new Database(sqlitePath, { create: true });

  const query = async <TRow extends SqlRow = SqlRow>(
    statement: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<Array<TRow>> => db.query(statement).all(...args) as Array<TRow>;

  const execute = async (
    statement: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<void> => {
    db.query(statement).run(...args);
  };

  return {
    backend: "sqlite",
    query,
    execute,
    transaction: makeSqliteTransaction(execute, query),
    close: async () => {
      db.close();
    },
  };
};

export const createSqliteAdapter = async (sqlitePath: string): Promise<SqlAdapter> => {
  const resolvedPath = path.resolve(sqlitePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });

  return isBunRuntime()
    ? createBunSqliteAdapter(resolvedPath)
    : createNodeSqliteAdapter(resolvedPath);
};

export const createPostgresAdapter = async (
  databaseUrl: string,
  applicationName: string | undefined,
): Promise<SqlAdapter> => {
  const client = postgres(databaseUrl, {
    prepare: false,
    max: 10,
    ...(applicationName ? { connection: { application_name: applicationName } } : {}),
  });

  type UnsafeRunner = {
    unsafe: Sql["unsafe"];
  };

  const toPostgresParams = (
    args: ReadonlyArray<unknown>,
  ): Array<postgres.ParameterOrJSON<never>> =>
    args as unknown as Array<postgres.ParameterOrJSON<never>>;

  const queryWith = async <TRow extends SqlRow = SqlRow>(
    runner: UnsafeRunner,
    statement: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<Array<TRow>> =>
    (await runner.unsafe(
      withPostgresPlaceholders(statement),
      toPostgresParams(args),
    )) as unknown as Array<TRow>;

  const executeWith = async (
    runner: UnsafeRunner,
    statement: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<void> => {
    await runner.unsafe(
      withPostgresPlaceholders(statement),
      toPostgresParams(args),
    );
  };

  const adapter: SqlAdapter = {
    backend: "postgres",
    query: (statement, args = []) => queryWith(client, statement, args),
    execute: (statement, args = []) => executeWith(client, statement, args),
    transaction: async <A>(run: (transaction: SqlAdapter) => Promise<A>) => {
      const result = await client.begin(async (transactionClient) => {
        const runner: UnsafeRunner = transactionClient;
        const transactionAdapter: SqlAdapter = {
          backend: "postgres",
          query: (statement, args = []) => queryWith(runner, statement, args),
          execute: (statement, args = []) => executeWith(runner, statement, args),
          transaction: async (nestedRun) => nestedRun(transactionAdapter),
          close: async () => {},
        };

        return run(transactionAdapter);
      });

      return result as unknown as A;
    },
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };

  return adapter;
};

const resolveDrizzleMigrationsFolder = (): string => {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "packages/persistence-sql/drizzle"),
    path.resolve(cwd, "../packages/persistence-sql/drizzle"),
    path.resolve(cwd, "../../packages/persistence-sql/drizzle"),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }

  throw new Error("Unable to resolve drizzle migrations folder");
};

const runMigrationQueries = async (
  adapter: SqlAdapter,
  queries: ReadonlyArray<string>,
): Promise<void> => {
  for (const query of queries) {
    const statement = query.trim();
    if (statement.length === 0) {
      continue;
    }

    await adapter.execute(statement);
  }
};

const toProxyRow = (row: unknown): unknown => {
  if (Array.isArray(row) || row === null || row === undefined) {
    return row;
  }

  if (typeof row === "object") {
    return Object.values(row as Record<string, unknown>);
  }

  return row;
};

const normalizeProxyRows = (
  method: "run" | "all" | "values" | "get",
  rows: ReadonlyArray<unknown>,
): Array<unknown> => {
  if (method === "get") {
    const first = rows[0];
    return first === undefined ? [] : [toProxyRow(first)];
  }

  return rows.map(toProxyRow);
};

const sqliteDrizzleSchema = {
  profileTable: profileSqliteTable,
  organizationsTable: organizationsSqliteTable,
  organizationMembershipsTable: organizationMembershipsSqliteTable,
  workspacesTable: workspacesSqliteTable,
  sourcesTable: sourcesSqliteTable,
  toolArtifactsTable: toolArtifactsSqliteTable,
  authConnectionsTable: authConnectionsSqliteTable,
  sourceAuthBindingsTable: sourceAuthBindingsSqliteTable,
  authMaterialsTable: authMaterialsSqliteTable,
  oauthStatesTable: oauthStatesSqliteTable,
  policiesTable: policiesSqliteTable,
  approvalsTable: approvalsSqliteTable,
  taskRunsTable: taskRunsSqliteTable,
  storageInstancesTable: storageInstancesSqliteTable,
  syncStatesTable: syncStatesSqliteTable,
};

type SqliteDrizzleSchema = typeof sqliteDrizzleSchema;
export type DrizzleDb = ReturnType<typeof drizzleSqliteProxy<SqliteDrizzleSchema>>;
export type DrizzleTables = SqliteDrizzleSchema;

export type DrizzleContext = {
  db: DrizzleDb;
  tables: DrizzleTables;
};

const createSqliteProxyDb = (adapter: SqlAdapter): DrizzleDb =>
  drizzleSqliteProxy(
    async (statement, params, method) => {
      if (method === "run") {
        await adapter.execute(statement, params);
        return { rows: [] };
      }

      const rows = await adapter.query(statement, params);
      return {
        rows: normalizeProxyRows(method, rows),
      };
    },
    {
      schema: sqliteDrizzleSchema,
    },
  );

export const createDrizzleContext = (adapter: SqlAdapter): DrizzleContext => ({
  db: createSqliteProxyDb(adapter),
  tables: sqliteDrizzleSchema,
});

const createPostgresMigrationDb = (adapter: SqlAdapter) =>
  drizzlePgProxy(async (statement, params, method) => {
    if (method === "execute") {
      await adapter.execute(statement, params);
      return { rows: [] };
    }

    const rows = await adapter.query(statement, params);
    return { rows };
  });

export const runMigrations = async (
  backend: SqlBackend,
  adapter: SqlAdapter,
): Promise<void> => {
  const migrationsFolder = resolveDrizzleMigrationsFolder();

  if (backend === "postgres") {
    const migrationDb = createPostgresMigrationDb(adapter);
    await migratePgProxy(
      migrationDb,
      async (queries) => runMigrationQueries(adapter, queries),
      {
        migrationsFolder,
      },
    );
    return;
  }

  const migrationDb = createSqliteProxyDb(adapter);
  await migrateSqliteProxy(
    migrationDb,
    async (queries) => runMigrationQueries(adapter, queries),
    {
      migrationsFolder,
    },
  );
};
