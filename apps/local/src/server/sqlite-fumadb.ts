import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { fumadb, type FumaDB } from "fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
  drizzleAdapter,
} from "fumadb/adapters/drizzle";
import { schema as fumaSchema } from "fumadb/schema";

import type { FumaDb, FumaTables } from "@executor-js/sdk";

export interface SqliteFumaDb {
  readonly db: FumaDb;
  readonly fuma: FumaDB;
  readonly drizzle: BunSQLiteDatabase<Record<string, unknown>>;
  readonly sqlite: Database;
  readonly close: () => Promise<void>;
}

export interface CreateSqliteFumaDbOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace: string;
  readonly version?: string;
  readonly path: string;
}

const asFumaDb = (db: unknown): FumaDb => db as FumaDb;
const asFumaClient = (client: unknown): FumaDB => client as FumaDB;

export const createSqliteFumaDb = async <const TTables extends FumaTables>(
  options: CreateSqliteFumaDbOptions<TTables>,
): Promise<SqliteFumaDb> => {
  const version = options.version ?? "1.0.0";
  const sqlite = new Database(options.path, { create: true });
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA journal_mode = WAL");

  const schema = createDrizzleRuntimeSchemaFromTables({
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "sqlite",
  });
  const drizzleDb = drizzle(sqlite, { schema });

  for (const statement of createDrizzleRuntimeSchemaSqlFromTables({
    tables: options.tables,
    namespace: options.namespace,
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
    namespace: options.namespace,
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
