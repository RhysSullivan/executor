import type * as Runtime from "alchemy/Cloudflare/Workers/Runtime";
import type { McpSessionShape } from "./mcp-session";

declare global {
  namespace Cloudflare {
    interface Env {
      // Bindings declared in alchemy.run.ts
      HYPERDRIVE: Hyperdrive;
      LOADER: WorkerLoader;
      MCP_SESSION: McpSessionNamespaceBinding;
      MARKETING: Fetcher;

      // WorkOS
      WORKOS_API_KEY: string;
      WORKOS_CLIENT_ID: string;
      WORKOS_COOKIE_PASSWORD: string;
      WORKOS_CLAIM_TOKEN: string;
      APP_URL: string;

      // Observability
      AXIOM_TOKEN?: string;
      AXIOM_DATASET?: string;
      AXIOM_TRACES_URL?: string;
      AXIOM_TRACES_SAMPLE_RATIO?: string;
      SENTRY_DSN?: string;
      VITE_PUBLIC_SENTRY_DSN?: string;
      VITE_PUBLIC_POSTHOG_KEY?: string;
      VITE_PUBLIC_POSTHOG_HOST?: string;

      // Datastore. Prod uses HYPERDRIVE when the binding exists; direct
      // DATABASE_URL is only selected when explicitly requested for local/test.
      DATABASE_URL?: string;
      EXECUTOR_DIRECT_DATABASE_URL?: string;

      // Billing
      AUTUMN_SECRET_KEY?: string;

      // MCP
      EXECUTOR_MCP_DEBUG?: string;
      MCP_AUTHKIT_DOMAIN?: string;
      MCP_RESOURCE_ORIGIN?: string;
      NODE_ENV?: string;

      // Shared with frontend
      VITE_PUBLIC_SITE_URL?: string;
    }
  }

  interface Env extends Cloudflare.Env {}

  namespace NodeJS {
    interface ProcessEnv extends StringifyValues<
      Pick<
        Cloudflare.Env,
        | "WORKOS_API_KEY"
        | "WORKOS_CLIENT_ID"
        | "WORKOS_COOKIE_PASSWORD"
        | "APP_URL"
        | "WORKOS_CLAIM_TOKEN"
      >
    > {}
  }
}

type StringifyValues<EnvType extends Record<string, unknown>> = {
  [Binding in keyof EnvType]: EnvType[Binding] extends string ? EnvType[Binding] : string;
};

type McpSessionNamespaceBinding = Runtime.DurableObjectNamespaceResource<McpSessionShape>;

export {};
