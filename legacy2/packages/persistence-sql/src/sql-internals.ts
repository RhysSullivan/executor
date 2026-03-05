import { PGlite } from "@electric-sql/pglite";
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePGlite } from "drizzle-orm/pglite";
import { migrate as migratePGlite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { readPersistenceSqlEnvironment } from "./config";

import {
  interactionsTable,
  authConnectionsTable,
  authMaterialsTable,
  oauthStatesTable,
  organizationMembershipsTable,
  organizationsTable,
  policiesTable,
  profileTable,
  secretMaterialsTable,
  sourceAuthBindingsTable,
  sourcesTable,
  storageInstancesTable,
  syncStatesTable,
  taskRunsTable,
  toolArtifactsTable,
  toolManifestsTable,
  workspacesTable,
} from "./schema";

export type SqlBackend = "pglite" | "postgres" | "postgres-neon-http";
type CreateSqlRuntimeOptions = {
  databaseUrl?: string;
  localDataDir: string;
  postgresApplicationName?: string;
};

const drizzleSchema = {
  profileTable,
  organizationsTable,
  organizationMembershipsTable,
  workspacesTable,
  sourcesTable,
  toolManifestsTable,
  toolArtifactsTable,
  authConnectionsTable,
  sourceAuthBindingsTable,
  authMaterialsTable,
  oauthStatesTable,
  secretMaterialsTable,
  policiesTable,
  interactionsTable,
  taskRunsTable,
  storageInstancesTable,
  syncStatesTable,
};

const createPGliteDb = (client: PGlite) => drizzlePGlite(client, { schema: drizzleSchema });
const createPostgresDb = (client: postgres.Sql) => drizzlePostgres(client, { schema: drizzleSchema });
const createNeonHttpDb = (client: ReturnType<typeof neon>) =>
  drizzleNeonHttp(client, { schema: drizzleSchema });

type PGliteDb = ReturnType<typeof createPGliteDb>;
type PostgresDb = ReturnType<typeof createPostgresDb>;
type NeonHttpDb = ReturnType<typeof createNeonHttpDb>;

export type DrizzleDb = PGliteDb | PostgresDb | NeonHttpDb;
export type DrizzleTables = typeof drizzleSchema;

type SqlRuntime = {
  backend: SqlBackend;
  db: DrizzleDb;
  close: () => Promise<void>;
  migrationDatabaseUrl?: string;
  migrationApplicationName?: string;
};

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const env = readPersistenceSqlEnvironment();

const resolvePostgresMaxConnections = (): number => {
  return env.nodeEnv === "production" ? 1 : 10;
};

const sanitizePostgresUrl = (value: string): string => {
  try {
    const parsed = new URL(value);

    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return value;
    }

    parsed.searchParams.delete("sslrootcert");
    parsed.searchParams.delete("sslcert");
    parsed.searchParams.delete("sslkey");
    parsed.searchParams.delete("sslcrl");
    parsed.searchParams.delete("max");
    parsed.searchParams.delete("idle_timeout");

    return parsed.toString();
  } catch {
    return value;
  }
};

const isPlanetScalePostgresHost = (databaseUrl: string): boolean => {
  try {
    return new URL(databaseUrl).hostname.endsWith(".pg.psdb.cloud");
  } catch {
    return false;
  }
};

const shouldUseNeonHttpDriver = (databaseUrl: string): boolean => {
  const configured = trim(env.controlPlanePostgresDriver);

  if (configured === "postgres-js") {
    return false;
  }

  if (configured === "neon-http") {
    return true;
  }

  return env.vercel === "1"
    && env.nodeEnv === "production"
    && isPlanetScalePostgresHost(databaseUrl);
};

const createPGliteRuntime = async (localDataDir: string): Promise<SqlRuntime> => {
  const resolvedDataDir = path.resolve(localDataDir);
  await mkdir(resolvedDataDir, { recursive: true });

  const client = new PGlite(resolvedDataDir);
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
  const client = postgres(sanitizePostgresUrl(databaseUrl), {
    prepare: false,
    max: resolvePostgresMaxConnections(),
    ...(applicationName ? { connection: { application_name: applicationName } } : {}),
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

const createNeonHttpRuntime = async (
  databaseUrl: string,
  applicationName: string | undefined,
): Promise<SqlRuntime> => {
  const sanitizedDatabaseUrl = sanitizePostgresUrl(databaseUrl);

  if (isPlanetScalePostgresHost(sanitizedDatabaseUrl)) {
    neonConfig.fetchEndpoint = (host: string) => `https://${host}/sql`;
  }

  const db = createNeonHttpDb(neon(sanitizedDatabaseUrl));

  return {
    backend: "postgres-neon-http",
    db,
    close: async () => {},
    migrationDatabaseUrl: sanitizedDatabaseUrl,
    migrationApplicationName: applicationName,
  };
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

export type DrizzleContext = {
  db: DrizzleDb;
  tables: DrizzleTables;
};

export const createDrizzleContext = (db: DrizzleDb): DrizzleContext => ({
  db,
  tables: drizzleSchema,
});

export const createSqlRuntime = async (
  options: CreateSqlRuntimeOptions,
): Promise<SqlRuntime> => {
  const databaseUrl = options.databaseUrl?.trim();
  if (
    databaseUrl
    && (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://"))
  ) {
    if (shouldUseNeonHttpDriver(databaseUrl)) {
      return createNeonHttpRuntime(databaseUrl, options.postgresApplicationName?.trim());
    }

    return createPostgresRuntime(databaseUrl, options.postgresApplicationName?.trim());
  }

  return createPGliteRuntime(options.localDataDir);
};

export const runMigrations = async (runtime: SqlRuntime): Promise<void> => {
  const migrationsFolder = resolveDrizzleMigrationsFolder();

  if (runtime.backend === "pglite") {
    await migratePGlite(runtime.db as PGliteDb, { migrationsFolder });
    return;
  }

  if (runtime.backend === "postgres-neon-http") {
    if (!runtime.migrationDatabaseUrl) {
      throw new Error("Missing migration database URL for neon-http runtime");
    }

    const migrationClient = postgres(runtime.migrationDatabaseUrl, {
      prepare: false,
      max: 1,
      ...(runtime.migrationApplicationName
        ? { connection: { application_name: runtime.migrationApplicationName } }
        : {}),
    });

    try {
      await migratePostgres(createPostgresDb(migrationClient), { migrationsFolder });
    } finally {
      await migrationClient.end({ timeout: 5 });
    }

    return;
  }

  await migratePostgres(runtime.db as PostgresDb, { migrationsFolder });
};
