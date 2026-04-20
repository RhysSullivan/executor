import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExecutorFileConfig } from "@executor/config";
import { syncFromConfig, type ConfigSyncExecutor } from "./config-sync";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "exec-config-sync-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const writeConfig = (config: ExecutorFileConfig): string => {
  const configPath = join(workDir, "executor.jsonc");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
};

const makeExecutorSpy = (): {
  calls: Array<unknown>;
  executor: ConfigSyncExecutor;
} => {
  const calls: Array<unknown> = [];
  return {
    calls,
    executor: {
      scopes: [{ id: "scope_test" }],
      openapi: {
        addSpec: () => Effect.void,
      },
      graphql: {
        addSource: () => Effect.void,
      },
      mcp: {
        addSource: (input: Record<string, unknown>) =>
          Effect.sync(() => {
            calls.push(input);
          }),
      },
    },
  };
};

describe("syncFromConfig", () => {
  it("replays remote MCP header auth from executor.jsonc into addSource", async () => {
    const configPath = writeConfig({
      sources: [
        {
          kind: "mcp",
          transport: "remote",
          name: "PostHog",
          endpoint: "https://mcp.posthog.com/mcp",
          namespace: "posthog",
          auth: {
            kind: "header",
            headerName: "Authorization",
            secret: "secret-public-ref:posthog-api-key",
            prefix: "Bearer ",
          },
        },
      ],
    });
    const { calls, executor } = makeExecutorSpy();

    await Effect.runPromise(syncFromConfig(executor, configPath));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      transport: "remote",
      scope: "scope_test",
      name: "PostHog",
      endpoint: "https://mcp.posthog.com/mcp",
      namespace: "posthog",
      auth: {
        kind: "header",
        headerName: "Authorization",
        secretId: "posthog-api-key",
        prefix: "Bearer ",
      },
    });
  });

  it("replays remote MCP oauth token refs from executor.jsonc into addSource", async () => {
    const configPath = writeConfig({
      sources: [
        {
          kind: "mcp",
          transport: "remote",
          name: "Example",
          endpoint: "https://example.com/mcp",
          namespace: "example",
          auth: {
            kind: "oauth2",
            accessTokenSecret: "secret-public-ref:mcp-oauth-access-example",
            refreshTokenSecret: "secret-public-ref:mcp-oauth-refresh-example",
            tokenType: "Bearer",
          },
        },
      ],
    });
    const { calls, executor } = makeExecutorSpy();

    await Effect.runPromise(syncFromConfig(executor, configPath));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      transport: "remote",
      scope: "scope_test",
      name: "Example",
      endpoint: "https://example.com/mcp",
      namespace: "example",
      auth: {
        kind: "oauth2",
        accessTokenSecretId: "mcp-oauth-access-example",
        refreshTokenSecretId: "mcp-oauth-refresh-example",
        tokenType: "Bearer",
        expiresAt: null,
        scope: null,
      },
    });
  });
});
