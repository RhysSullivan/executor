import { fumadb, type FumaDB } from "fumadb";
import { drizzleAdapter, type DrizzleConfig } from "fumadb/adapters/drizzle";
import { schema as fumaSchema } from "fumadb/schema";

import type { FumaDb, FumaTables } from "@executor-js/sdk";

export interface DrizzleFumaDb {
  readonly db: FumaDb;
  readonly fuma: FumaDB;
}

export interface CreateDrizzleFumaDbOptions<TTables extends FumaTables = FumaTables> {
  readonly db: DrizzleConfig["db"];
  readonly tables: TTables;
  readonly namespace: string;
  readonly version?: string;
  readonly provider: DrizzleConfig["provider"];
}

const asFumaDb = (db: unknown): FumaDb => db as FumaDb;
const asFumaClient = (client: unknown): FumaDB => client as FumaDB;

export const createDrizzleFumaDb = <const TTables extends FumaTables>(
  options: CreateDrizzleFumaDbOptions<TTables>,
): DrizzleFumaDb => {
  const version = options.version ?? "1.0.0";
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
      db: options.db,
      provider: options.provider,
    }),
  );

  return {
    db: asFumaDb(fuma.orm(version)),
    fuma: asFumaClient(fuma),
  };
};
