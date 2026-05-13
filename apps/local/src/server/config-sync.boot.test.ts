// Boot-time replay of MCP auth from `executor.jsonc`. The plugin already
// resolves `secret-public-ref:` strings at connect time via
// `ctx.secrets.get` — the regression class here is auth being silently
// dropped at the config boundary. `mcp.addSource` persists the source
// row even when the remote is unreachable, so unreachable endpoints are
// enough to assert on the stored auth shape without running an MCP
// server. The new credential-binding flow does require referenced
// secrets/connections to exist at the target scope, hence the seeds
// before each test.

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SECRET_REF_PREFIX, type ExecutorFileConfig } from "@executor-js/config";
import {
  ConnectionId,
  CreateConnectionInput,
  OAUTH2_PROVIDER_KEY,
  ScopeId,
  SecretId,
  TokenMaterial,
  createExecutor,
  definePlugin,
  makeTestConfig,
  type SecretProvider,
} from "@executor-js/sdk";
import { mcpPlugin } from "@executor-js/plugin-mcp";

import { syncFromConfig } from "./config-sync";
import type { LocalExecutor } from "./executor";

const UNREACHABLE = "http://127.0.0.1:1/mcp";
const TEST_SCOPE = ScopeId.make("test-scope");

const makeMemorySecretsPlugin = () => {
  const store = new Map<string, string>();
  const provider: SecretProvider = {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(`${scope} ${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope} ${id}`, value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(`${scope} ${id}`)),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((k) => {
          const id = k.split(" ", 2)[1] ?? k;
          return { id, name: id };
        }),
      ),
  };
  return definePlugin(() => ({
    id: "memory-secrets" as const,
    storage: () => ({}),
    secretProviders: [provider],
  }));
};

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
  createExecutor(makeTestConfig({ plugins: [makeMemorySecretsPlugin()(), mcpPlugin()] as const }));

describe("syncFromConfig — MCP auth replay", () => {
  it.effect("strips secret-public-ref prefix from header auth", () =>
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
      yield* executor.secrets.set({
        id: SecretId.make("posthog-api-key"),
        scope: TEST_SCOPE,
        name: "PostHog API Key",
        value: "phx_test_token",
        provider: "memory",
      });

      yield* syncFromConfig({
        // The test executor uses a narrower plugin tuple than LocalExecutor (no
        // openapi/graphql), but Match in addSourceFromConfig only dispatches to
        // the mcp branch for these fixtures, so the missing methods are never
        // touched at runtime.
        // oxlint-disable-next-line executor/no-double-cast
        executor: executor as unknown as LocalExecutor,
        configPath,
        targetScope: TEST_SCOPE,
      });

      const stored = yield* executor.mcp.getSource("posthog", TEST_SCOPE);
      expect(stored).not.toBeNull();
      expect(stored!.config).toMatchObject({
        transport: "remote",
        endpoint: UNREACHABLE,
        auth: {
          kind: "header",
          headerName: "Authorization",
          secretSlot: "auth:header",
          prefix: "Bearer ",
        },
      });
    }),
  );

  it.effect("passes oauth2 auth through unchanged", () =>
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
      const connectionId = ConnectionId.make("mcp-oauth2-linear");
      yield* executor.connections.create(
        CreateConnectionInput.make({
          id: connectionId,
          scope: TEST_SCOPE,
          provider: OAUTH2_PROVIDER_KEY,
          identityLabel: "user@example.com",
          accessToken: TokenMaterial.make({
            secretId: SecretId.make(`${connectionId}.access_token`),
            name: "MCP Access Token",
            value: "access-token-value",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: {
            endpoint: UNREACHABLE,
            tokenType: "Bearer",
            clientInformation: { client_id: "fake" },
            authorizationServerUrl: null,
            authorizationServerMetadata: null,
            resourceMetadataUrl: null,
            resourceMetadata: null,
          },
        }),
      );

      yield* syncFromConfig({
        // oxlint-disable-next-line executor/no-double-cast
        executor: executor as unknown as LocalExecutor,
        configPath,
        targetScope: TEST_SCOPE,
      });

      const stored = yield* executor.mcp.getSource("linear", TEST_SCOPE);
      expect(stored!.config).toMatchObject({
        transport: "remote",
        auth: { kind: "oauth2", connectionSlot: "auth:oauth2:connection" },
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

      yield* syncFromConfig({
        // oxlint-disable-next-line executor/no-double-cast
        executor: executor as unknown as LocalExecutor,
        configPath,
        targetScope: TEST_SCOPE,
      });

      const stored = yield* executor.mcp.getSource("devin", TEST_SCOPE);
      expect(stored!.config).toMatchObject({
        transport: "remote",
        auth: { kind: "none" },
      });
    }),
  );
});
