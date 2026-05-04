// Augment the wrangler-generated `Cloudflare.Env` with secrets / vars set at
// deploy time (via `wrangler secret put`, dashboard, or `.dev.vars`) that
// don't show up in `wrangler types` output because they aren't declared in
// wrangler.jsonc, but are what `env.X` resolves to at runtime.
declare global {
  namespace Cloudflare {
    interface Env {
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

      // Contact / Slack Connect
      SLACK_BOT_TOKEN?: string;
      // Turnstile (Cloudflare CAPTCHA) — used to gate the public Slack-contact
      // endpoint. Sitekey is public and ships in `vars`; secret is set via
      // `wrangler secret put TURNSTILE_SECRET_KEY`.
      TURNSTILE_SECRET_KEY?: string;
      VITE_PUBLIC_TURNSTILE_SITEKEY?: string;
      // Cloudflare ratelimit binding declared in wrangler.jsonc — caps total
      // Slack-contact channel creations across all callers.
      SLACK_INVITE_LIMITER: { limit: (input: { key: string }) => Promise<{ success: boolean }> };

      // MCP
      EXECUTOR_MCP_DEBUG?: string;
      MCP_AUTHKIT_DOMAIN?: string;
      MCP_RESOURCE_ORIGIN?: string;
      NODE_ENV?: string;

      // Shared with frontend
      VITE_PUBLIC_SITE_URL?: string;
    }
  }
}

export {};
