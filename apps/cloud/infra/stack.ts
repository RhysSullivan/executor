import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import McpSessionDO from "../src/mcp-session";

const DEFAULT_LOCAL_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";

export const cloudWorker = (appDir: string, hyperdrive: Cloudflare.Hyperdrive) =>
  Cloudflare.Vite("Cloud", {
    rootDir: appDir,
    name: "executor-cloud",
    compatibility: {
      date: "2025-04-01",
      flags: ["nodejs_compat"],
    },
    domain: "executor.sh",
    limits: {
      cpuMs: 30000,
    },
    observability: { enabled: true },
    placement: { region: "aws:us-east-1" },
    env: {
      APP_URL: process.env.APP_URL ?? publicSiteUrl(),
      ...optionalTextEnv("AUTUMN_SECRET_KEY"),
      ...optionalTextEnv("AXIOM_DATASET"),
      ...optionalTextEnv("AXIOM_TOKEN"),
      ...optionalTextEnv("AXIOM_TRACES_SAMPLE_RATIO"),
      ...optionalTextEnv("AXIOM_TRACES_URL"),
      ...optionalTextEnv("ENCRYPTION_KEY"),
      ...optionalTextEnv("MCP_AUTHKIT_DOMAIN"),
      ...optionalTextEnv("MCP_RESOURCE_ORIGIN"),
      ...optionalTextEnv("SENTRY_DSN"),
      ...optionalTextEnv("SLACK_BOT_TOKEN"),
      ...optionalTextEnv("TURNSTILE_SECRET_KEY"),
      VITE_PUBLIC_SITE_URL: publicSiteUrl(),
      ...optionalTextEnv("VITE_PUBLIC_SENTRY_DSN"),
      VITE_PUBLIC_POSTHOG_KEY: "phc_nNLrNMALpRsfrEkZovUkfMxYbcJvHnsJHeoSPavprgLL",
      ...optionalTextEnv("VITE_PUBLIC_POSTHOG_HOST"),
      ...optionalTextEnv("VITE_PUBLIC_TURNSTILE_SITEKEY"),
      WORKOS_API_KEY: requiredText("WORKOS_API_KEY"),
      ...optionalTextEnv("WORKOS_CLAIM_TOKEN"),
      WORKOS_CLIENT_ID: requiredText("WORKOS_CLIENT_ID"),
      WORKOS_COOKIE_PASSWORD: requiredText("WORKOS_COOKIE_PASSWORD"),
      ...localDirectDatabaseEnv(),
    },
    bindings: {
      MCP_SESSION: McpSessionDO,
      LOADER: Cloudflare.DynamicWorkerLoader("LOADER"),
      MARKETING: Cloudflare.ServiceBinding("executor-marketing"),
      HYPERDRIVE: hyperdrive,
    },
    memo: {
      include: [
        "alchemy.run.ts",
        "executor.config.ts",
        "index.html",
        "package.json",
        "scripts/**",
        "src/**",
        "vite.config.ts",
        "../../package.json",
        "../../bun.lock",
        "../../packages/**/package.json",
        "../../packages/**/src/**",
      ],
    },
  });

export const cloudStack = (appDir: string) =>
  Effect.gen(function* () {
    const origin = yield* hyperdriveOriginFromUrl(
      Redacted.make(process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL),
    );
    const hyperdrive = yield* Cloudflare.Hyperdrive("HYPERDRIVE", {
      name: "planetscale-executor-main-axub",
      origin,
      dev: {
        scheme: "postgresql",
        host: "127.0.0.1",
        port: 5433,
        database: "postgres",
        user: "postgres",
        password: Redacted.make("postgres"),
        sslmode: "prefer",
      },
    });

    const worker = yield* cloudWorker(appDir, hyperdrive);

    return {
      workerName: worker.workerName,
      url: worker.url,
    };
  });

const hyperdriveOriginFromUrl = (
  databaseUrl: Redacted.Redacted<string>,
): Effect.Effect<Cloudflare.HyperdrivePublicOrigin> =>
  Effect.gen(function* () {
    const url = new URL(Redacted.value(databaseUrl));
    const scheme = yield* parseHyperdriveScheme(url.protocol);
    return {
      scheme,
      host: url.hostname || "127.0.0.1",
      port: url.port ? Number(url.port) : undefined,
      database: decodeURIComponent(url.pathname.replace(/^\/+/, "")) || defaultDatabase(scheme),
      user: decodeURIComponent(url.username || defaultUser(scheme)),
      password: Redacted.make(decodeURIComponent(url.password || defaultPassword(scheme))),
    };
  });

const parseHyperdriveScheme = (protocol: string): Effect.Effect<Cloudflare.HyperdriveScheme> =>
  Effect.gen(function* () {
    const normalized = protocol.replace(/:$/, "");
    if (!isHyperdriveScheme(normalized)) {
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: Alchemy stack bodies cannot carry typed user-input validation errors
      return yield* Effect.die(`Unsupported Hyperdrive protocol: ${normalized}`);
    }
    return hyperdriveScheme(normalized);
  });

const isHyperdriveScheme = (value: string): value is Cloudflare.HyperdriveScheme =>
  Match.value(value).pipe(
    Match.when("mysql", () => true),
    Match.when("postgres", () => true),
    Match.when("postgresql", () => true),
    Match.orElse(() => false),
  );

const hyperdriveScheme = (protocol: Cloudflare.HyperdriveScheme): Cloudflare.HyperdriveScheme =>
  Match.value(protocol).pipe(
    Match.when("mysql", () => "mysql" as const),
    Match.when("postgres", () => "postgres" as const),
    Match.when("postgresql", () => "postgresql" as const),
    Match.exhaustive,
  );

const defaultDatabase = (scheme: Cloudflare.HyperdriveScheme): string =>
  Match.value(scheme).pipe(
    Match.when("mysql", () => "mysql"),
    Match.when("postgres", () => "postgres"),
    Match.when("postgresql", () => "postgres"),
    Match.exhaustive,
  );

const defaultUser = (scheme: Cloudflare.HyperdriveScheme): string =>
  Match.value(scheme).pipe(
    Match.when("mysql", () => "root"),
    Match.when("postgres", () => "postgres"),
    Match.when("postgresql", () => "postgres"),
    Match.exhaustive,
  );

const defaultPassword = (scheme: Cloudflare.HyperdriveScheme): string =>
  Match.value(scheme).pipe(
    Match.when("mysql", () => ""),
    Match.when("postgres", () => "postgres"),
    Match.when("postgresql", () => "postgres"),
    Match.exhaustive,
  );

const requiredText = (name: string): string => process.env[name] ?? "";

const optionalText = (name: string): string | undefined => process.env[name];

const publicSiteUrl = (): string =>
  process.env.VITE_PUBLIC_SITE_URL ?? process.env.PORTLESS_URL ?? "https://executor.sh";

const optionalTextEnv = (name: string): Record<string, string> => {
  const value = optionalText(name);
  return value === undefined ? {} : { [name]: value };
};

const localDirectDatabaseEnv = (): Record<string, string> =>
  process.env.EXECUTOR_DIRECT_DATABASE_URL === "true"
    ? {
        EXECUTOR_DIRECT_DATABASE_URL: "true",
        DATABASE_URL: DEFAULT_LOCAL_DATABASE_URL,
      }
    : {};
