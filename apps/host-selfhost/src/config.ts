import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isValidOrgSlug } from "@executor-js/api";

// ---------------------------------------------------------------------------
// Self-host server config — a single typed surface parsed from the
// environment. Slice 1 keeps this a plain loader with safe defaults; it can
// graduate to Effect-Schema validation without changing call sites.
// ---------------------------------------------------------------------------

export const SELF_HOST_NAMESPACE = "executor_selfhost";
export const SELF_HOST_SCHEMA_VERSION = "1.0.0";

export interface SelfHostConfig {
  /** Bind address. Defaults to loopback. */
  readonly host: string;
  readonly port: number;
  /** Absolute path to the SQLite database file. */
  readonly dbPath: string;
  /** Public base URL used by core tools that build absolute links. */
  readonly webBaseUrl: string;
  /**
   * Whether sandboxed code may reach loopback/private network addresses.
   * Defaults to false — adversarial LLM code should not hit the host's
   * internal network unless an operator opts in.
   */
  readonly allowLocalNetwork: boolean;
  // Better Auth session secret. Always resolved (env, else generated + persisted
  // under the data dir) so a single-container deploy boots with no env; the auth
  // layer still validates an explicitly-set env secret is long enough.
  readonly authSecret: string;
  readonly bootstrapAdminEmail: string | undefined;
  readonly bootstrapAdminPassword: string | undefined;
  readonly bootstrapAdminName: string;
  /** The single organization every self-host user belongs to. */
  readonly organizationName: string;
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  readonly orgSlug: string;
}

export const resolveDataDir = (): string =>
  process.env.EXECUTOR_DATA_DIR ?? join(process.cwd(), ".executor-selfhost");

let cachedSecretKey: string | undefined;

/**
 * Master key for the encrypted secret provider. Prefers EXECUTOR_SECRET_KEY;
 * otherwise generates and persists a random key under the data dir on first
 * boot (so a single-container deploy is encrypted-by-default without manual
 * setup). Memoized so repeated per-request reads are cheap.
 */
export const resolveSecretKey = (): string => {
  if (cachedSecretKey) return cachedSecretKey;
  const fromEnv = process.env.EXECUTOR_SECRET_KEY?.trim();
  if (fromEnv) {
    cachedSecretKey = fromEnv;
    return fromEnv;
  }
  const keyPath = join(resolveDataDir(), "secret.key");
  if (existsSync(keyPath)) {
    cachedSecretKey = readFileSync(keyPath, "utf8").trim();
    return cachedSecretKey;
  }
  mkdirSync(resolveDataDir(), { recursive: true });
  const generated = randomBytes(32).toString("base64");
  writeFileSync(keyPath, generated, { mode: 0o600 });
  console.warn(
    `[executor] generated a secret-encryption key at ${keyPath}. Set EXECUTOR_SECRET_KEY to manage it explicitly (and to keep secrets readable across data-dir changes).`,
  );
  cachedSecretKey = generated;
  return generated;
};

let cachedAuthSecret: string | undefined;

/**
 * Better Auth session secret. Prefers BETTER_AUTH_SECRET / AUTH_SECRET;
 * otherwise generates and persists a strong random secret under the data dir on
 * first boot (so a single-container deploy boots with no env and keeps sessions
 * valid across restarts). Memoized; mirrors {@link resolveSecretKey}.
 */
export const resolveAuthSecret = (): string => {
  if (cachedAuthSecret) return cachedAuthSecret;
  const fromEnv = (process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET)?.trim();
  if (fromEnv) {
    cachedAuthSecret = fromEnv;
    return fromEnv;
  }
  const keyPath = join(resolveDataDir(), "auth-secret.key");
  if (existsSync(keyPath)) {
    cachedAuthSecret = readFileSync(keyPath, "utf8").trim();
    return cachedAuthSecret;
  }
  mkdirSync(resolveDataDir(), { recursive: true });
  const generated = randomBytes(32).toString("base64");
  writeFileSync(keyPath, generated, { mode: 0o600 });
  console.warn(
    `[executor] generated a session secret at ${keyPath}. Set BETTER_AUTH_SECRET to manage it explicitly (rotating it signs everyone out).`,
  );
  cachedAuthSecret = generated;
  return generated;
};

// Public origin a PaaS injects for this service, e.g. Railway's
// `RAILWAY_PUBLIC_DOMAIN`. Mirrors the ordering of @t3-oss/env-core's
// `getPlatformOrigin` preset (MIT) — these are platform-set (not client-set)
// values, so building absolute URLs from them is safe (unlike the request
// `Host`). Returns an origin (`https://host`) or undefined. We deliberately omit
// the generic `PUBLIC_URL`/`APP_URL` from that preset: `PUBLIC_URL` is a *path*
// in some toolchains (CRA), not an origin, and would mislead here.
const getPlatformOrigin = (env = process.env): string | undefined => {
  const host =
    env.RAILWAY_PUBLIC_DOMAIN ??
    env.RENDER_EXTERNAL_HOSTNAME ??
    env.VERCEL_PROJECT_PRODUCTION_URL ??
    env.VERCEL_URL ??
    env.HEROKU_APP_DEFAULT_DOMAIN_NAME ??
    env.WEBSITE_HOSTNAME ?? // Azure App Service
    env.WEBSITE_DEFAULT_HOSTNAME ??
    (env.FLY_APP_NAME ? `${env.FLY_APP_NAME}.fly.dev` : undefined) ??
    (env.SITE_NAME ? `${env.SITE_NAME}.netlify.app` : undefined);
  const url =
    env.RENDER_EXTERNAL_URL ??
    env.DEPLOY_PRIME_URL ?? // Netlify (deploy/branch previews)
    env.URL ?? // Netlify (primary site URL)
    env.CF_PAGES_URL ??
    (host ? `https://${host}` : undefined);
  return url?.replace(/\/+$/, "");
};

let warnedNoPublicUrl = false;

// The public origin used to build absolute links (OAuth redirects, MCP OAuth
// metadata, the connect-card URL). Priority: an explicit EXECUTOR_WEB_BASE_URL,
// then a platform-injected origin (zero-config on Railway/Render/Fly/…), then a
// localhost fallback for local dev. NEVER derived from the request `Host` —
// that's spoofable and would let host-header injection poison those links (the
// request origin is only trusted for the CSRF/`trustedOrigins` check, which is
// same-origin-safe; see better-auth.ts).
const resolveWebBaseUrl = (port: number): string => {
  const explicit = process.env.EXECUTOR_WEB_BASE_URL?.trim();
  if (explicit) return explicit;
  const platform = getPlatformOrigin();
  if (platform) return platform;
  const fallback = `http://localhost:${port}`;
  // A deployed instance with no detectable origin will mint localhost OAuth
  // redirects / email links — warn once so the operator sets the variable
  // (signup itself still works; trustedOrigins takes the origin from the
  // request). Quiet in dev, where localhost is correct.
  if (!warnedNoPublicUrl && process.env.NODE_ENV === "production") {
    warnedNoPublicUrl = true;
    console.warn(
      `[executor] EXECUTOR_WEB_BASE_URL is not set and no platform origin was detected; falling back to ${fallback}. Sign-in works, but OAuth redirects, MCP metadata, and connect links will use this URL. Set EXECUTOR_WEB_BASE_URL to your public origin (e.g. https://your-instance.example.com).`,
    );
  }
  return fallback;
};

export const loadConfig = (): SelfHostConfig => {
  const port = Number.parseInt(process.env.PORT ?? "4788", 10);
  const dataDir = resolveDataDir();
  return {
    host: process.env.EXECUTOR_HOST ?? "127.0.0.1",
    port,
    dbPath: process.env.EXECUTOR_DB_PATH ?? join(dataDir, "data.db"),
    webBaseUrl: resolveWebBaseUrl(port),
    allowLocalNetwork: process.env.EXECUTOR_ALLOW_LOCAL_NETWORK === "true",
    authSecret: resolveAuthSecret(),
    bootstrapAdminEmail: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
    bootstrapAdminPassword: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
    bootstrapAdminName: process.env.EXECUTOR_BOOTSTRAP_ADMIN_NAME ?? "Admin",
    organizationName: process.env.EXECUTOR_ORG_NAME ?? "Default",
    orgSlug: resolveOrgSlug(),
  };
};

// The org slug doubles as a URL segment (`/<slug>/policies`), so an
// operator-set value must fit the shared grammar and avoid reserved root
// segments (api, mcp, login, …) — a colliding slug would shadow real routes.
const resolveOrgSlug = (): string => {
  const slug = process.env.EXECUTOR_ORG_SLUG;
  if (!slug) return "default";
  if (!isValidOrgSlug(slug) && slug !== "default") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a colliding org slug would shadow app routes; refuse to boot
    throw new Error(
      `EXECUTOR_ORG_SLUG ${JSON.stringify(slug)} is not usable as a URL slug (2-48 chars of [a-z0-9-], not a reserved path segment like "api" or "login")`,
    );
  }
  return slug;
};
