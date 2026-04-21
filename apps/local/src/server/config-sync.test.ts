// ---------------------------------------------------------------------------
// Integration test for boot-time config sync.
//
// Drives `syncFromConfig` against a real in-memory executor and asserts
// the replayed source lands in the DB with the correct runtime shape —
// specifically that remote MCP auth makes it through the file→runtime
// transform intact. Covers the regression class where an auth field is
// silently dropped somewhere along the replay path.
//
// `mcp.addSource` for remote sources persists the row even when auth
// resolution or tool discovery fails (see #364), so we don't need to
// seed secrets or stand up a real MCP server — an unreachable endpoint
// is enough to assert on the stored auth shape.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SECRET_REF_PREFIX, type ExecutorFileConfig } from "@executor/config";
import { createExecutor, makeTestConfig } from "@executor/sdk";
import { mcpPlugin } from "@executor/plugin-mcp";
import { openApiPlugin } from "@executor/plugin-openapi";
import { graphqlPlugin } from "@executor/plugin-graphql";

import { syncFromConfig } from "./config-sync";

const UNREACHABLE = "http://127.0.0.1:1/mcp";
const TEST_SCOPE = "test-scope";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "exec-config-sync-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const writeConfig = (config: ExecutorFileConfig): string => {
  const path = join(workDir, "executor.jsonc");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
};

const makeExecutor = () =>
  createExecutor(
    makeTestConfig({
      plugins: [mcpPlugin(), openApiPlugin(), graphqlPlugin()] as const,
    }),
  );

describe("syncFromConfig", () => {
  it.effect("replays remote MCP header auth with the secret-ref prefix stripped", () =>
    Effect.gen(function* () {
      const configPath = writeConfig({
        sources: [
          {
            kind: "mcp",
            transport: "remote",
            name: "PostHog",
            endpoint: UNREACHABLE,
            namespace: "posthog",
            auth: {
              kind: "header",
              headerName: "Authorization",
              secret: `${SECRET_REF_PREFIX}posthog-api-key`,
              prefix: "Bearer ",
            },
          },
        ],
      });
      const executor = yield* makeExecutor();

      yield* syncFromConfig(executor, configPath);

      const stored = yield* executor.mcp.getSource("posthog", TEST_SCOPE);
      expect(stored).not.toBeNull();
      expect(stored!.config).toMatchObject({
        transport: "remote",
        endpoint: UNREACHABLE,
        auth: {
          kind: "header",
          headerName: "Authorization",
          secretId: "posthog-api-key",
          prefix: "Bearer ",
        },
      });
    }),
  );

  it.effect("replays remote MCP oauth2 auth preserving connectionId", () =>
    Effect.gen(function* () {
      const configPath = writeConfig({
        sources: [
          {
            kind: "mcp",
            transport: "remote",
            name: "Linear",
            endpoint: UNREACHABLE,
            namespace: "linear",
            auth: { kind: "oauth2", connectionId: "mcp-oauth2-linear" },
          },
        ],
      });
      const executor = yield* makeExecutor();

      yield* syncFromConfig(executor, configPath);

      const stored = yield* executor.mcp.getSource("linear", TEST_SCOPE);
      expect(stored).not.toBeNull();
      expect(stored!.config).toMatchObject({
        transport: "remote",
        auth: { kind: "oauth2", connectionId: "mcp-oauth2-linear" },
      });
    }),
  );

  it.effect("preserves kind:none auth on replay", () =>
    Effect.gen(function* () {
      const configPath = writeConfig({
        sources: [
          {
            kind: "mcp",
            transport: "remote",
            name: "DeepWiki",
            endpoint: UNREACHABLE,
            namespace: "devin",
            auth: { kind: "none" },
          },
        ],
      });
      const executor = yield* makeExecutor();

      yield* syncFromConfig(executor, configPath);

      const stored = yield* executor.mcp.getSource("devin", TEST_SCOPE);
      expect(stored!.config).toMatchObject({
        transport: "remote",
        auth: { kind: "none" },
      });
    }),
  );

  it.effect("skips a missing config file without error", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const missing = join(workDir, "does-not-exist.jsonc");

      yield* syncFromConfig(executor, missing);

      // No MCP source should be created from the missing file. Plugins
      // may seed their own static control sources — filter to MCP only.
      const sources = yield* executor.sources.list();
      expect(sources.filter((s) => s.kind === "mcp")).toHaveLength(0);
    }),
  );
});
