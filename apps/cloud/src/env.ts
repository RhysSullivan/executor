import { createEnv, Env } from "@executor/env";

const sharedShape = {
  NODE_ENV: Env.literalOr("NODE_ENV", "development", "development", "test", "production"),
};

const serverShape = {
  DATABASE_URL: Env.stringOr("DATABASE_URL", ""),
  ENCRYPTION_KEY: Env.string("ENCRYPTION_KEY"),
  WORKOS_API_KEY: Env.string("WORKOS_API_KEY"),
  WORKOS_CLIENT_ID: Env.string("WORKOS_CLIENT_ID"),
  WORKOS_COOKIE_PASSWORD: Env.string("WORKOS_COOKIE_PASSWORD"),
  VITE_PUBLIC_SITE_URL: Env.stringOr("VITE_PUBLIC_SITE_URL", ""),
  AUTUMN_SECRET_KEY: Env.stringOr("AUTUMN_SECRET_KEY", ""),
  SENTRY_DSN: Env.stringOr("SENTRY_DSN", ""),
  AXIOM_TOKEN: Env.stringOr("AXIOM_TOKEN", ""),
  AXIOM_DATASET: Env.stringOr("AXIOM_DATASET", "executor-cloud"),
};

type SharedEnv = Readonly<{
  NODE_ENV: "development" | "test" | "production";
}>;

type ServerEnv = SharedEnv &
  Readonly<{
    DATABASE_URL: string;
    ENCRYPTION_KEY: string;
    WORKOS_API_KEY: string;
    WORKOS_CLIENT_ID: string;
    WORKOS_COOKIE_PASSWORD: string;
    VITE_PUBLIC_SITE_URL: string;
    AUTUMN_SECRET_KEY: string;
    SENTRY_DSN: string;
    AXIOM_TOKEN: string;
    AXIOM_DATASET: string;
  }>;

type WebEnv = Readonly<Record<string, never>>;

export const shared = createEnv(sharedShape, {
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
}) as SharedEnv;

export const web = createEnv(
  {},
  {
    prefix: "PUBLIC_",
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
  },
) as WebEnv;

export const server = createEnv(serverShape, {
  extends: [shared],
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
}) as ServerEnv;
