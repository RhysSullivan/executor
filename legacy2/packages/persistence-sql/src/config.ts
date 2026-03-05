import { configSchema, server } from "better-env/config-schema";

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const persistenceSqlEnvConfig = configSchema("PersistenceSqlEnvironment", {
  nodeEnv: server({ env: "NODE_ENV", optional: true }),
  vercel: server({ env: "VERCEL", optional: true }),
  controlPlanePostgresDriver: server({
    env: "CONTROL_PLANE_POSTGRES_DRIVER",
    optional: true,
  }),
  databaseUrl: server({ env: "DATABASE_URL", optional: true }),
});

export type PersistenceSqlEnvironment = {
  nodeEnv: string;
  vercel: string | undefined;
  controlPlanePostgresDriver: string | undefined;
  databaseUrl: string | undefined;
};

export const readPersistenceSqlEnvironment = (): PersistenceSqlEnvironment => {
  const env = persistenceSqlEnvConfig.server;

  return {
    nodeEnv: trim(env.nodeEnv) ?? "development",
    vercel: trim(env.vercel),
    controlPlanePostgresDriver: trim(env.controlPlanePostgresDriver)?.toLowerCase(),
    databaseUrl: trim(env.databaseUrl),
  };
};
