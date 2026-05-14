import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fumadb, type FumaDB } from "fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
  drizzleAdapter,
} from "fumadb/adapters/drizzle";
import { schema as fumaSchema } from "fumadb/schema";

import type { FumaDb, FumaTables } from "./fuma-runtime";

export interface SqliteTestFumaDb {
  readonly db: FumaDb;
  readonly fuma: FumaDB;
  readonly drizzle: BetterSQLite3Database<Record<string, unknown>>;
  readonly sqlite: Database.Database;
  readonly close: () => Promise<void>;
}

export interface CreateSqliteTestFumaDbOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace?: string;
  readonly version?: string;
  readonly path?: string;
}

const asFumaDb = (db: unknown): FumaDb => db as FumaDb;
const asFumaClient = (client: unknown): FumaDB => client as FumaDB;

export const createSqliteTestFumaDb = async <const TTables extends FumaTables>(
  options: CreateSqliteTestFumaDbOptions<TTables>,
): Promise<SqliteTestFumaDb> => {
  const version = options.version ?? "1.0.0";
  const namespace = options.namespace ?? "executor_test";
  if (options.path && options.path !== ":memory:") {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  const sqlite = new Database(options.path ?? ":memory:");
  sqlite.pragma("foreign_keys = ON");

  const schema = createDrizzleRuntimeSchemaFromTables({
    tables: options.tables,
    namespace,
    version,
    provider: "sqlite",
  });
  const drizzleDb = drizzle(sqlite, { schema });

  for (const statement of createDrizzleRuntimeSchemaSqlFromTables({
    tables: options.tables,
    namespace,
    version,
    provider: "sqlite",
  })) {
    sqlite.exec(statement);
  }

  const latestSchema = fumaSchema({
    version,
    tables: options.tables,
  });
  const factory = fumadb({
    namespace,
    schemas: [latestSchema],
  });
  const fuma = factory.client(
    drizzleAdapter({
      db: drizzleDb,
      provider: "sqlite",
    }),
  );

  return {
    db: asFumaDb(fuma.orm(version)),
    fuma: asFumaClient(fuma),
    drizzle: drizzleDb,
    sqlite,
    close: async () => {
      sqlite.close();
    },
  };
};
