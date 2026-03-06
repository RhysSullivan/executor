import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePGlite } from "drizzle-orm/pglite";
import { migrate as migratePGlite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { drizzleSchema, type DrizzleTables } from "./schema";

export type SqlBackend = "pglite" | "postgres";

export type CreateSqlRuntimeOptions = {
  databaseUrl?: string;
  localDataDir?: string;
  postgresApplicationName?: string;
  migrationsFolder?: string;
};

const createPGliteDb = (client: PGlite) =>
  drizzlePGlite({ client, schema: drizzleSchema });

const createPostgresDb = (client: postgres.Sql) =>
  drizzlePostgres({ client, schema: drizzleSchema });

export type PGliteDb = ReturnType<typeof createPGliteDb>;
export type PostgresDb = ReturnType<typeof createPostgresDb>;
export type DrizzleDb = PGliteDb | PostgresDb;

export type SqlRuntime = {
  backend: SqlBackend;
  db: DrizzleDb;
  close: () => Promise<void>;
};

export type DrizzleContext = {
  db: DrizzleDb;
  tables: DrizzleTables;
};

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const isPostgresUrl = (value: string): boolean =>
  value.startsWith("postgres://") || value.startsWith("postgresql://");

const createPGliteRuntime = async (localDataDir: string): Promise<SqlRuntime> => {
  const normalized = trim(localDataDir) ?? ".executor-v3/control-plane-pgdata";

  let client: PGlite;
  if (normalized === ":memory:") {
    client = new PGlite();
  } else {
    const resolvedDataDir = path.resolve(normalized);
    if (!existsSync(resolvedDataDir)) {
      await mkdir(resolvedDataDir, { recursive: true });
    }
    client = new PGlite(resolvedDataDir);
  }

  const db = createPGliteDb(client);

  return {
    backend: "pglite",
    db,
    close: async () => {
      await client.close();
    },
  };
};

const createPostgresRuntime = async (
  databaseUrl: string,
  applicationName: string | undefined,
): Promise<SqlRuntime> => {
  const client = postgres(databaseUrl, {
    prepare: false,
    max: 10,
    ...(applicationName
      ? { connection: { application_name: applicationName } }
      : {}),
  });
  const db = createPostgresDb(client);

  return {
    backend: "postgres",
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
};

const resolveMigrationsFolder = (explicit: string | undefined): string => {
  const explicitTrimmed = trim(explicit);
  if (explicitTrimmed) {
    return path.resolve(explicitTrimmed);
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, "../..");
  const cwd = process.cwd();
  const candidates = [
    path.resolve(packageRoot, "drizzle"),
    path.resolve(cwd, "packages/control-plane/drizzle"),
    path.resolve(cwd, "drizzle"),
  ];

  const hasModernMigrations = (candidate: string): boolean => {
    if (!existsSync(candidate)) {
      return false;
    }

    const entries = readdirSync(candidate, { withFileTypes: true });
    return entries.some(
      (entry) =>
        entry.isDirectory()
        && existsSync(path.join(candidate, entry.name, "migration.sql")),
    );
  };

  for (const candidate of candidates) {
    if (
      existsSync(path.join(candidate, "meta", "_journal.json"))
      || hasModernMigrations(candidate)
    ) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to resolve Drizzle migrations folder for control-plane persistence",
  );
};

export const runMigrations = async (
  runtime: SqlRuntime,
  options?: { migrationsFolder?: string },
): Promise<void> => {
  const migrationsFolder = resolveMigrationsFolder(options?.migrationsFolder);

  if (runtime.backend === "pglite") {
    await migratePGlite(runtime.db as PGliteDb, { migrationsFolder });
    return;
  }

  await migratePostgres(runtime.db as PostgresDb, { migrationsFolder });
};

export const createSqlRuntime = async (
  options: CreateSqlRuntimeOptions,
): Promise<SqlRuntime> => {
  const databaseUrl = trim(options.databaseUrl);
  const runtime =
    databaseUrl && isPostgresUrl(databaseUrl)
      ? await createPostgresRuntime(
          databaseUrl,
          trim(options.postgresApplicationName),
        )
      : await createPGliteRuntime(
          options.localDataDir ?? ".executor-v3/control-plane-pgdata",
        );

  return runtime;
};

export const createDrizzleContext = (db: DrizzleDb): DrizzleContext => ({
  db,
  tables: drizzleSchema,
});
