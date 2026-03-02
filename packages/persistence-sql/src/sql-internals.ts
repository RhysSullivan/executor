import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePgProxy } from "drizzle-orm/pg-proxy";
import { migrate as migratePgProxy } from "drizzle-orm/pg-proxy/migrator";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

import {
  approvalsTable,
  authConnectionsTable,
  authMaterialsTable,
  oauthStatesTable,
  organizationMembershipsTable,
  organizationsTable,
  policiesTable,
  profileTable,
  sourceAuthBindingsTable,
  sourcesTable,
  storageInstancesTable,
  syncStatesTable,
  taskRunsTable,
  toolArtifactsTable,
  workspacesTable,
} from "./schema";

export type SqlBackend = "pglite" | "postgres";
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

const withPostgresPlaceholders = (statement: string): string => {
  let index = 0;
  return statement.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
};

const toPostgresStatement = (statement: string): string => withPostgresPlaceholders(statement);

const makePGliteTransaction = (
  execute: (statement: string, args?: ReadonlyArray<unknown>) => Promise<void>,
  query: <TRow extends SqlRow = SqlRow>(
    statement: string,
    args?: ReadonlyArray<unknown>,
  ) => Promise<Array<TRow>>,
): SqlAdapter["transaction"] =>
  async <A>(run: (transactionAdapter: SqlAdapter) => Promise<A>): Promise<A> => {
    await execute("BEGIN");

    try {
      const adapter: SqlAdapter = {
        backend: "pglite",
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

export const createPGliteAdapter = async (localDataDir: string): Promise<SqlAdapter> => {
  const resolvedDataDir = path.resolve(localDataDir);
  await mkdir(path.dirname(resolvedDataDir), { recursive: true });

  const db = new PGlite(resolvedDataDir);

  const query = async <TRow extends SqlRow = SqlRow>(
    statement: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<Array<TRow>> => {
    const result = await db.query(toPostgresStatement(statement), [...args]);
    return result.rows as Array<TRow>;
  };

  const execute = async (
    statement: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<void> => {
    await db.query(toPostgresStatement(statement), [...args]);
  };

  return {
    backend: "pglite",
    query,
    execute,
    transaction: makePGliteTransaction(execute, query),
    close: async () => {
      await db.close();
    },
  };
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
      toPostgresStatement(statement),
      toPostgresParams(args),
    )) as unknown as Array<TRow>;

  const executeWith = async (
    runner: UnsafeRunner,
    statement: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<void> => {
    await runner.unsafe(
      toPostgresStatement(statement),
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

      return result as A;
    },
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };

  return adapter;
};

const resolveDrizzleMigrationsFolder = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, "..");
  const cwd = process.cwd();
  const candidates = [
    path.resolve(packageRoot, "drizzle"),
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
  method: "execute" | "all" | "values" | "get",
  rows: ReadonlyArray<unknown>,
): Array<unknown> => {
  if (method === "get") {
    const first = rows[0];
    return first === undefined ? [] : [toProxyRow(first)];
  }

  return rows.map(toProxyRow);
};

const drizzleSchema = {
  profileTable,
  organizationsTable,
  organizationMembershipsTable,
  workspacesTable,
  sourcesTable,
  toolArtifactsTable,
  authConnectionsTable,
  sourceAuthBindingsTable,
  authMaterialsTable,
  oauthStatesTable,
  policiesTable,
  approvalsTable,
  taskRunsTable,
  storageInstancesTable,
  syncStatesTable,
};

type DrizzleSchema = typeof drizzleSchema;
type PostgresDrizzleDb = ReturnType<typeof drizzlePgProxy<DrizzleSchema>>;

export type DrizzleDb = PostgresDrizzleDb;
export type DrizzleTables = DrizzleSchema;

export type DrizzleContext = {
  db: DrizzleDb;
  tables: DrizzleTables;
};

const createPostgresProxyDb = (adapter: SqlAdapter): PostgresDrizzleDb =>
  drizzlePgProxy(
    async (statement, params, method) => {
      if (method === "execute") {
        await adapter.execute(statement, params);
        return { rows: [] };
      }

      const rows = await adapter.query(statement, params);
      return {
        rows: normalizeProxyRows(method, rows),
      };
    },
    {
      schema: drizzleSchema,
    },
  );

export const createDrizzleContext = (adapter: SqlAdapter): DrizzleContext => ({
  db: createPostgresProxyDb(adapter),
  tables: drizzleSchema,
});

export const runMigrations = async (adapter: SqlAdapter): Promise<void> => {
  const migrationDb = createPostgresProxyDb(adapter);
  const migrationsFolder = resolveDrizzleMigrationsFolder();

  await migratePgProxy(
    migrationDb,
    async (queries) => runMigrationQueries(adapter, queries),
    {
      migrationsFolder,
    },
  );
};
