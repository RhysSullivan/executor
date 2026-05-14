import { PGlite } from "@electric-sql/pglite";
import {
  PGLiteSocketServer,
  type PGLiteSocketServer as PgliteSocketServer,
} from "@electric-sql/pglite-socket";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import type { FumaDB } from "fumadb";

import type { FumaDb, FumaTables } from "./fuma-runtime";
import { createDrizzleFumaDb } from "./drizzle";
import { createPostgresDrizzleSchema, ensurePostgresFumaSchema } from "./drizzle-schema";

export interface PgliteFumaDb {
  readonly db: FumaDb;
  readonly fuma: FumaDB;
  readonly drizzle: PgliteDatabase<any>;
  readonly pglite: PGlite;
  readonly server: PgliteSocketServer | null;
  readonly connectionString: string | null;
  readonly close: () => Promise<void>;
}

export interface CreatePgliteFumaDbOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace?: string;
  readonly version?: string;
  readonly dataDir?: string;
  readonly host?: string;
  readonly port?: number;
}

export const createPgliteFumaDb = async <const TTables extends FumaTables>(
  options: CreatePgliteFumaDbOptions<TTables>,
): Promise<PgliteFumaDb> => {
  const version = options.version ?? "1.0.0";
  const namespace = options.namespace ?? "executor";
  const pglite = await PGlite.create(options.dataDir ?? "memory://");
  const drizzleSchema = createPostgresDrizzleSchema({
    tables: options.tables,
    namespace,
    version,
  });
  const drizzleDb = drizzle({
    client: pglite,
    schema: drizzleSchema,
  });
  await ensurePostgresFumaSchema(drizzleDb, {
    tables: options.tables,
    namespace,
    version,
  });
  const fuma = createDrizzleFumaDb({
    db: drizzleDb,
    tables: options.tables,
    namespace,
    version,
    provider: "postgresql",
  });

  const server =
    options.host || options.port
      ? new PGLiteSocketServer({
          db: pglite,
          host: options.host,
          port: options.port ?? 0,
        })
      : null;

  await server?.start();

  const connectionString = server
    ? (() => {
        const [host, port] = server.getServerConn().split(":");
        return `postgres://postgres:postgres@${host}:${port}/postgres`;
      })()
    : null;

  return {
    db: fuma.db,
    fuma: fuma.fuma,
    drizzle: drizzleDb,
    pglite,
    server,
    connectionString,
    close: async () => {
      await server?.stop();
      await pglite.close();
    },
  };
};
