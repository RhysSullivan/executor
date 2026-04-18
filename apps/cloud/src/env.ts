// ---------------------------------------------------------------------------
// Env accessors for apps/cloud.
// ---------------------------------------------------------------------------
//
// `server` / `shared` are lazy Proxies over `cloudflare:workers` `env`, with
// a `process.env` fallback for the node-pool tests (which stub
// `cloudflare:workers` to an empty `env` and rely on vitest to populate
// `process.env`). Reads happen at the call site, not at module load, so
// secrets land correctly in both the edge isolate and the Durable Object
// isolate — the latter previously captured empty strings at env.ts
// module-load time and silently broke `DoTelemetryLive`, `AutumnService`
// billing writes, and likely other DO-reachable secret readers.
//
// Types below mirror the prior `createEnv(...)`-derived shapes so every
// caller (`server.X`) keeps the same typed surface.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";

type SharedEnv = Readonly<{
  NODE_ENV: "development" | "test" | "production";
}>;

type ServerEnv = SharedEnv &
  Readonly<{
    DATABASE_URL: string;
    MCP_SESSION_REQUEST_SCOPED_RUNTIME: "false" | "true";
    WORKOS_API_KEY: string;
    WORKOS_CLIENT_ID: string;
    WORKOS_COOKIE_PASSWORD: string;
    VITE_PUBLIC_SITE_URL: string;
    MCP_AUTHKIT_DOMAIN: string;
    MCP_RESOURCE_ORIGIN: string;
    AUTUMN_SECRET_KEY: string;
    SENTRY_DSN: string;
    AXIOM_TOKEN: string;
    AXIOM_DATASET: string;
    AXIOM_TRACES_URL: string;
  }>;

type WebEnv = Readonly<Record<string, never>>;

const SERVER_DEFAULTS: Record<keyof ServerEnv, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "",
  MCP_SESSION_REQUEST_SCOPED_RUNTIME: "false",
  WORKOS_API_KEY: "",
  WORKOS_CLIENT_ID: "",
  WORKOS_COOKIE_PASSWORD: "",
  VITE_PUBLIC_SITE_URL: "",
  MCP_AUTHKIT_DOMAIN: "https://signin.executor.sh",
  MCP_RESOURCE_ORIGIN: "https://executor.sh",
  AUTUMN_SECRET_KEY: "",
  SENTRY_DSN: "",
  AXIOM_TOKEN: "",
  AXIOM_DATASET: "executor-cloud",
  AXIOM_TRACES_URL: "https://api.axiom.co/v1/traces",
};

const SHARED_DEFAULTS: Record<keyof SharedEnv, string> = {
  NODE_ENV: "development",
};

const readFromWorkerEnv = (key: string): string | undefined => {
  const bag = env as unknown as Record<string, unknown>;
  const v = bag[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

const readFromProcessEnv = (key: string): string | undefined => {
  if (typeof process === "undefined" || !process.env) return undefined;
  const v = process.env[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

const read = (key: string): string | undefined =>
  readFromWorkerEnv(key) ?? readFromProcessEnv(key);

const makeEnvProxy = <T extends object>(defaults: Record<string, string>): T =>
  new Proxy({} as T, {
    get: (_target, key) => {
      if (typeof key !== "string") return undefined;
      return read(key) ?? defaults[key] ?? "";
    },
  });

export const shared: SharedEnv = makeEnvProxy<SharedEnv>(SHARED_DEFAULTS);
export const server: ServerEnv = makeEnvProxy<ServerEnv>(SERVER_DEFAULTS);
export const web: WebEnv = {} as WebEnv;
