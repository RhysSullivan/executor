import { describe, expect, test } from "bun:test";
import { buildEnvChecks, parseConvexEnvList } from "./doctor-prod";

describe("parseConvexEnvList", () => {
  test("parses key value lines and ignores comments", () => {
    const env = parseConvexEnvList([
      "# comment",
      "CONVEX_URL=https://example.convex.cloud",
      "EXECUTOR_INTERNAL_TOKEN=abc=def",
      "",
    ].join("\n"));

    expect(env.get("CONVEX_URL")).toBe("https://example.convex.cloud");
    expect(env.get("EXECUTOR_INTERNAL_TOKEN")).toBe("abc=def");
    expect(env.has("# comment")).toBe(false);
  });
});

describe("buildEnvChecks", () => {
  test("flags missing required production env vars", () => {
    const checks = buildEnvChecks(new Map());
    const byName = new Map(checks.map((check) => [check.name, check]));

    expect(byName.get("env:CLOUDFLARE_SANDBOX_RUN_URL")?.ok).toBe(false);
    expect(byName.get("env:CLOUDFLARE_SANDBOX_AUTH_TOKEN")?.ok).toBe(false);
    expect(byName.get("env:EXECUTOR_INTERNAL_TOKEN")?.ok).toBe(false);
    expect(byName.get("env:CONVEX_URL")?.ok).toBe(false);
    expect(byName.get("env:WORKOS_CLIENT_ID")?.ok).toBe(false);
    expect(byName.get("env:WORKOS_API_KEY")?.ok).toBe(false);
    expect(byName.get("env:WORKOS_WEBHOOK_SECRET")?.ok).toBe(false);
    expect(byName.get("env:WORKOS_COOKIE_PASSWORD")?.ok).toBe(false);
    expect(byName.get("env:STRIPE_SECRET_KEY")?.ok).toBe(false);
    expect(byName.get("env:STRIPE_WEBHOOK_SECRET")?.ok).toBe(false);
    expect(byName.get("env:STRIPE_PRICE_ID")?.ok).toBe(false);
    expect(byName.get("env:auth server")?.ok).toBe(false);
  });

  test("rejects CONVEX_URL pointing to convex.site", () => {
    const env = new Map<string, string>([
      ["CLOUDFLARE_SANDBOX_RUN_URL", "https://executor-sandbox-host.example.workers.dev/v1/runs"],
      ["CLOUDFLARE_SANDBOX_AUTH_TOKEN", "abcdefghijklmnopqrstuvwxyz0123456789"],
      ["EXECUTOR_INTERNAL_TOKEN", "abcdefghijklmnopqrstuvwxyz0123456789"],
      ["CONVEX_URL", "https://perceptive-pigeon-577.convex.site"],
      ["WORKOS_CLIENT_ID", "client_123"],
      ["WORKOS_API_KEY", "sk_test_123"],
      ["WORKOS_WEBHOOK_SECRET", "whsec_123"],
      ["WORKOS_COOKIE_PASSWORD", "cookie_password_123"],
      ["STRIPE_SECRET_KEY", "sk_live_123"],
      ["STRIPE_WEBHOOK_SECRET", "whsec_live_123"],
      ["STRIPE_PRICE_ID", "price_123"],
      ["MCP_AUTHORIZATION_SERVER", "https://auth.example.com"],
    ]);

    const checks = buildEnvChecks(env);
    const hostTypeCheck = checks.find((check) => check.name === "convex URL host type");
    expect(hostTypeCheck?.ok).toBe(false);
  });

  test("accepts well-formed cloud configuration", () => {
    const env = new Map<string, string>([
      ["CLOUDFLARE_SANDBOX_RUN_URL", "https://executor-sandbox-host.example.workers.dev/v1/runs"],
      ["CLOUDFLARE_SANDBOX_AUTH_TOKEN", "abcdefghijklmnopqrstuvwxyz0123456789"],
      ["EXECUTOR_INTERNAL_TOKEN", "abcdefghijklmnopqrstuvwxyz0123456789"],
      ["CONVEX_URL", "https://perceptive-pigeon-577.convex.cloud"],
      ["CONVEX_SITE_URL", "https://perceptive-pigeon-577.convex.site"],
      ["WORKOS_CLIENT_ID", "client_123"],
      ["WORKOS_API_KEY", "sk_test_123"],
      ["WORKOS_WEBHOOK_SECRET", "whsec_123"],
      ["WORKOS_COOKIE_PASSWORD", "cookie_password_123"],
      ["STRIPE_SECRET_KEY", "sk_live_123"],
      ["STRIPE_WEBHOOK_SECRET", "whsec_live_123"],
      ["STRIPE_PRICE_ID", "price_123"],
      ["MCP_AUTHORIZATION_SERVER", "https://auth.example.com"],
    ]);

    const checks = buildEnvChecks(env);
    const failures = checks.filter((check) => !check.ok);
    expect(failures).toEqual([]);
  });
});
