import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import { makeSourceManagerService } from "@executor-v2/management-api";
import {
  createRunExecutor,
  createSourceToolRegistry,
  makeOpenApiToolProvider,
  makeRuntimeAdapterRegistry,
  makeToolProviderRegistry,
} from "@executor-v2/engine";
import { makeSqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import { SourceSchema, type Source } from "@executor-v2/schema";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/runtime-local-inproc";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  createPmApprovalsService,
  createPmPersistentToolApprovalPolicy,
} from "./approvals-service";
import { createPmExecuteRuntimeRun } from "./runtime-execution-port";

type TestServer = {
  baseUrl: string;
  requests: Array<string>;
  close: () => Promise<void>;
};

const decodeSource = Schema.decodeUnknownSync(SourceSchema);

const githubOwnerParam = HttpApiSchema.param("owner", Schema.String);
const githubRepoParam = HttpApiSchema.param("repo", Schema.String);

class GitHubReposApi extends HttpApiGroup.make("repos").add(
  HttpApiEndpoint.get("getRepo")`/repos/${githubOwnerParam}/${githubRepoParam}`.addSuccess(
    Schema.Unknown,
  ),
) {}

class GitHubApi extends HttpApi.make("github").add(GitHubReposApi) {}

const githubOpenApiSpec = OpenApi.fromApi(GitHubApi);

const getHeaderValue = (req: IncomingMessage, key: string): string | null => {
  const value = req.headers[key];
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return null;
};

const makeTestServer = Effect.acquireRelease(
  Effect.promise<TestServer>(
    () =>
      new Promise<TestServer>((resolve, reject) => {
        const requests: Array<string> = [];

        const server = createServer((req, res) => {
          const host = getHeaderValue(req, "host") ?? "127.0.0.1";
          const url = new URL(req.url ?? "/", `http://${host}`);

          if (url.pathname === "/repos/octocat/hello-world" && req.method === "GET") {
            requests.push(url.pathname);
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                full_name: "octocat/hello-world",
                stargazers_count: 42,
              }),
            );
            return;
          }

          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "not found" }));
        });

        server.once("error", (error) => reject(error));
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("failed to resolve test server address"));
            return;
          }

          resolve({
            baseUrl: `http://127.0.0.1:${address.port}`,
            requests,
            close: () =>
              new Promise<void>((closeResolve, closeReject) => {
                server.close((error) => {
                  if (error) {
                    closeReject(error);
                    return;
                  }

                  closeResolve();
                });
              }),
          });
        });
      }),
  ),
  (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
);

const withFixedRandomUuid = <A>(
  fixedValue: string,
  run: () => Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = crypto.randomUUID;
      (crypto as { randomUUID: () => string }).randomUUID = () => fixedValue;
      return original;
    }),
    () => run(),
    (original) =>
      Effect.sync(() => {
        (crypto as { randomUUID: () => string }).randomUUID = original;
      }).pipe(Effect.orDie),
  );

const setupApprovalRuntimeHarness = (runId: string) =>
  Effect.gen(function* () {
    const stateDir = yield* Effect.acquireRelease(
      Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "executor-v2-approval-e2e-")),
      ),
      (directory) =>
        Effect.promise(() =>
          rm(directory, { recursive: true, force: true }),
        ).pipe(Effect.orDie),
    );

    const persistence = yield* Effect.acquireRelease(
      makeSqlControlPlanePersistence({
        sqlitePath: path.resolve(stateDir, "control-plane.sqlite"),
      }),
      (resource) => Effect.promise(() => resource.close()).pipe(Effect.orDie),
    );

    const server = yield* makeTestServer;

    const source: Source = decodeSource({
      id: "src_github",
      workspaceId: "ws_local",
      name: "github",
      kind: "openapi",
      endpoint: server.baseUrl,
      status: "connected",
      enabled: true,
      configJson: JSON.stringify({ baseUrl: server.baseUrl }),
      sourceHash: null,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    yield* persistence.sourceStore.upsert(source);

    const sourceManager = makeSourceManagerService(persistence.toolArtifactStore);
    yield* sourceManager.refreshOpenApiArtifact({
      source,
      openApiSpec: githubOpenApiSpec,
    });

    const approvalsService = createPmApprovalsService(persistence.rows);
    const approvalPolicy = createPmPersistentToolApprovalPolicy(persistence.rows, {
      requireApprovals: true,
      retryAfterMs: 50,
    });

    const toolRegistry = createSourceToolRegistry({
      workspaceId: source.workspaceId,
      sourceStore: persistence.sourceStore,
      toolArtifactStore: persistence.toolArtifactStore,
      toolProviderRegistry: makeToolProviderRegistry([makeOpenApiToolProvider()]),
      approvalPolicy,
    });

    const discovered = yield* toolRegistry.discover({ query: "repo", limit: 5 });
    const toolPath = discovered.bestPath;
    if (!toolPath) {
      throw new Error("expected source tool discovery to return a bestPath");
    }

    const toolPathAccessor = toolPath
      .split(".")
      .map((segment) => `[${JSON.stringify(segment)}]`)
      .join("");

    const code = `
const response = await tools${toolPathAccessor}({ owner: "octocat", repo: "hello-world" });
return response.body.full_name;
`;

    const runtimeAdapters = makeRuntimeAdapterRegistry([
      makeLocalInProcessRuntimeAdapter(),
    ]);

    const executeRuntimeRun = createPmExecuteRuntimeRun({
      defaultRuntimeKind: "local-inproc",
      runtimeAdapters,
      toolRegistry,
    });

    const executor = createRunExecutor(executeRuntimeRun, {
      makeRunId: () => runId,
    });

    return {
      persistence,
      server,
      source,
      approvalsService,
      executor,
      code,
    };
  });

describe("PM approval execution E2E", () => {
  it.scoped("persists pending approval, resolves it, and completes sandbox tool call", () =>
    Effect.gen(function* () {
      const { persistence, server, source, approvalsService, executor, code } =
        yield* setupApprovalRuntimeHarness("run_approval_e2e");

      const firstAttempt = yield* withFixedRandomUuid("approval_call_e2e", () =>
        executor.executeRun({ code }),
      );

      expect(firstAttempt.status).toBe("failed");
      if (firstAttempt.status === "failed") {
        expect(firstAttempt.error).toContain("requires approval");
      }

      const approvalsAfterFirstAttempt = yield* persistence.rows.approvals.list();
      expect(approvalsAfterFirstAttempt).toHaveLength(1);

      const pendingApproval = approvalsAfterFirstAttempt[0];
      if (!pendingApproval) {
        throw new Error("expected pending approval record");
      }

      expect(pendingApproval.status).toBe("pending");

      yield* approvalsService.resolveApproval({
        workspaceId: source.workspaceId,
        approvalId: pendingApproval.id,
        payload: {
          status: "approved",
          reason: "approved in e2e test",
        },
      });

      const secondAttempt = yield* withFixedRandomUuid("approval_call_e2e", () =>
        executor.executeRun({ code }),
      );

      expect(secondAttempt.status).toBe("completed");
      if (secondAttempt.status === "completed") {
        expect(secondAttempt.result).toBe("octocat/hello-world");
      }

      const approvalsAfterSecondAttempt = yield* persistence.rows.approvals.list();
      expect(approvalsAfterSecondAttempt[0]?.status).toBe("approved");
      expect(server.requests).toEqual(["/repos/octocat/hello-world"]);
    }),
  );

  it.scoped("persists pending approval and blocks execution when denied", () =>
    Effect.gen(function* () {
      const { persistence, server, source, approvalsService, executor, code } =
        yield* setupApprovalRuntimeHarness("run_approval_e2e_denied");

      const firstAttempt = yield* withFixedRandomUuid("approval_call_e2e_denied", () =>
        executor.executeRun({ code }),
      );

      expect(firstAttempt.status).toBe("failed");
      if (firstAttempt.status === "failed") {
        expect(firstAttempt.error).toContain("requires approval");
      }

      const approvalsAfterFirstAttempt = yield* persistence.rows.approvals.list();
      expect(approvalsAfterFirstAttempt).toHaveLength(1);

      const pendingApproval = approvalsAfterFirstAttempt[0];
      if (!pendingApproval) {
        throw new Error("expected pending approval record");
      }

      expect(pendingApproval.status).toBe("pending");

      yield* approvalsService.resolveApproval({
        workspaceId: source.workspaceId,
        approvalId: pendingApproval.id,
        payload: {
          status: "denied",
          reason: "denied in e2e test",
        },
      });

      const secondAttempt = yield* withFixedRandomUuid("approval_call_e2e_denied", () =>
        executor.executeRun({ code }),
      );

      expect(secondAttempt.status).toBe("failed");
      if (secondAttempt.status === "failed") {
        expect((secondAttempt.error ?? "").toLowerCase()).toContain("denied");
      }

      const approvalsAfterSecondAttempt = yield* persistence.rows.approvals.list();
      expect(approvalsAfterSecondAttempt[0]?.status).toBe("denied");
      expect(server.requests).toEqual([]);
    }),
  );
});
