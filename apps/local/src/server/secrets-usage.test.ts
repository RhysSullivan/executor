import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpApiClient } from "@effect/platform";

import { addGroup } from "@executor/api";
import { ScopeId, SecretId } from "@executor/sdk";
import { SecretsUsageApi } from "@executor/react/api/secrets-usage";
import { OpenApiGroup } from "@executor/plugin-openapi/api";

import { createServerHandlers } from "./main";
import { disposeExecutor } from "./executor";

const TEST_BASE_URL = "http://local.test";

const makeScopeId = (cwd: string): string => {
  const folder = basename(cwd) || cwd;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
};

const LocalTestApi = addGroup(SecretsUsageApi).add(OpenApiGroup);

let dataDir: string;
let scopeDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "executor-local-data-"));
  scopeDir = mkdtempSync(join(tmpdir(), "executor-local-scope-"));
  process.env.EXECUTOR_DATA_DIR = dataDir;
  process.env.EXECUTOR_SCOPE_DIR = scopeDir;
});

afterEach(async () => {
  await disposeExecutor();
  delete process.env.EXECUTOR_DATA_DIR;
  delete process.env.EXECUTOR_SCOPE_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(scopeDir, { recursive: true, force: true });
});

describe("local secrets usage api", () => {
  it("lists source usage for secrets referenced by local sources", async () => {
    const handlers = await createServerHandlers();
    const fetchImpl: typeof globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return handlers.api.handler(request);
    }) as typeof globalThis.fetch;

    const clientEffect = Effect.gen(function* () {
      const client = yield* HttpApiClient.make(LocalTestApi, { baseUrl: TEST_BASE_URL });
      const scopeId = ScopeId.make(makeScopeId(scopeDir));
      const secretId = SecretId.make("local_usage_secret");

      yield* client.secrets.set({
        path: { scopeId },
        payload: {
          id: secretId,
          name: "Local token",
          value: "sk-local-usage",
        },
      });

      yield* client.openapi.addSpec({
        path: { scopeId },
        payload: {
          spec: "https://openapi.vercel.sh",
          namespace: "local_vercel",
          baseUrl: "https://api.vercel.com",
          headers: {
            Authorization: {
              secretId: secretId,
              prefix: "Bearer ",
            },
          },
        },
      });

      return yield* client.secretsUsage.list({ path: { scopeId } });
    }).pipe(
      Effect.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
        ),
      ),
    );

    await expect(Effect.runPromise(clientEffect)).resolves.toEqual([
      {
        secretId: "local_usage_secret",
        usedBy: [
          {
            sourceId: "local_vercel",
            sourceName: "Vercel API",
            sourceKind: "openapi",
          },
        ],
      },
    ]);

    await handlers.api.dispose();
    await handlers.mcp.close();
  });
});
