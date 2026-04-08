import { createEnv, Env } from "@executor/env";

const sharedShape = {
  NODE_ENV: Env.literalOr(
    "NODE_ENV",
    "development",
    "development",
    "test",
    "production",
  ),
};

const serverShape = {
  DATABASE_URL: Env.stringOr("DATABASE_URL", ""),
  PGLITE_DATA_DIR: Env.stringOr("PGLITE_DATA_DIR", ".pglite"),
  ENCRYPTION_KEY: Env.stringOr(
    "ENCRYPTION_KEY",
    "local-dev-encryption-key",
  ),
  WORKOS_API_KEY: Env.string("WORKOS_API_KEY"),
  WORKOS_CLIENT_ID: Env.string("WORKOS_CLIENT_ID"),
  WORKOS_COOKIE_PASSWORD: Env.string("WORKOS_COOKIE_PASSWORD"),
};

type SharedEnv = Readonly<{
  NODE_ENV: "development" | "test" | "production";
}>;

type ServerEnv = SharedEnv & Readonly<{
  DATABASE_URL: string;
  PGLITE_DATA_DIR: string;
  ENCRYPTION_KEY: string;
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  WORKOS_COOKIE_PASSWORD: string;
}>;

type WebEnv = Readonly<Record<string, never>>;

export const shared = createEnv(sharedShape, {
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
}) as SharedEnv;

export const web = createEnv({}, {
  prefix: "PUBLIC_",
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
}) as WebEnv;

export const server = createEnv(serverShape, {
  extends: [shared],
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
}) as ServerEnv;
