import { createServer } from "node:http";
import { join } from "node:path";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import {
  ExecutionIdSchema,
  ExecutionInteractionIdSchema,
  type ExecutionInteraction,
  ProviderAuthGrantIdSchema,
  SecretMaterialIdSchema,
  SourceAuthSessionIdSchema,
  SourceIdSchema,
  WorkspaceOauthClientIdSchema,
} from "#schema";
import type { ToolPath } from "@executor/codemode-core";
import { createCatalogImportMetadata } from "@executor/source-core";
import { createGraphqlCatalogFragment } from "@executor/source-graphql";
import { createWorkspaceExecutorAdminToolMap } from "../../../internal/src/index";

import {
  type ExecutorRuntime,
  LiveExecutionManagerService,
  provideExecutorRuntime,
  RuntimeExecutionResolverService,
} from "./index";
import { createSourceFromPayload } from "./sources/source-definitions";
import { decodeSourceCredentialSelectionContent } from "./sources/source-credential-interactions";
import { persistSource } from "./sources/source-store";
import {
  withExecutorApiClient,
  withExecutorApiRequestHandler,
} from "./execution/test-http-client";
import { runtimeEffectError } from "./effect-errors";
import {
  buildLocalSourceArtifact,
  createLocalExecutorRuntime as createExecutorRuntime,
  deriveLocalInstallation,
  readLocalSourceArtifact,
  resolveLocalWorkspaceContext,
  writeLocalExecutorStateSnapshot,
  writeLocalSourceArtifact,
  writeProjectLocalExecutorConfig,
  writeLocalWorkspaceState,
} from "../../../sdk-file/src/index";
import {
  decodeSourceCredentialInteraction,
  submitSourceCredentialInteraction,
} from "../local/operations";

const makeRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped({
    prefix: "executor-runtime-",
  });
  const homeConfigPath = join(workspaceRoot, ".executor-home.jsonc");
  const homeStateDirectory = join(workspaceRoot, ".executor-home-state");

  return yield* Effect.acquireRelease(
    createExecutorRuntime({
      workspaceRoot,
      homeConfigPath,
      homeStateDirectory,
      createInternalToolMap: createWorkspaceExecutorAdminToolMap,
    }),
    (runtime) => Effect.promise(() => runtime.close()).pipe(Effect.orDie),
  );
}).pipe(Effect.provide(NodeFileSystem.layer));

type OpenApiSpecServer = {
  baseUrl: string;
  specUrl: string;
  close: () => Promise<void>;
};

type GoogleWorkspaceTestServer = {
  baseUrl: string;
  tokenEndpoint: string;
  discoveryUrl: (input: {
    service: string;
    version: string;
    scope: string;
  }) => string;
  queueTokenResponse: (response: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }) => void;
  tokenRequests: URLSearchParams[];
  discoveryAuthorizations: string[];
  close: () => Promise<void>;
};

const makeOpenApiSpecServer = Effect.acquireRelease(
  Effect.promise<OpenApiSpecServer>(
    () =>
      new Promise<OpenApiSpecServer>((resolve, reject) => {
        const openApiDocument = JSON.stringify({
          openapi: "3.0.3",
          info: {
            title: "GitHub Test API",
            version: "1.0.0",
          },
          paths: {
            "/repos/{owner}/{repo}": {
              get: {
                operationId: "repos/get-repo",
                tags: ["repos"],
                summary: "Get a repository",
                responses: {
                  200: {
                    description: "ok",
                  },
                },
              },
            },
          },
        });

        const server = createServer((request, response) => {
          if (request.url !== "/openapi.json") {
            response.statusCode = 404;
            response.end();
            return;
          }

          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end(openApiDocument);
        });

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Failed to bind OpenAPI runtime test server"));
            return;
          }

          const baseUrl = `http://127.0.0.1:${address.port}`;
          resolve({
            baseUrl,
            specUrl: `${baseUrl}/openapi.json`,
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

const makeGoogleWorkspaceTestServer = Effect.acquireRelease(
  Effect.promise<GoogleWorkspaceTestServer>(
    () =>
      new Promise<GoogleWorkspaceTestServer>((resolve, reject) => {
        const discoveryScopes = new Map<string, string>();
        const tokenResponses: Array<{
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
        }> = [];
        const tokenRequests: URLSearchParams[] = [];
        const discoveryAuthorizations: string[] = [];
        let baseUrl = "";

        const server = createServer(async (request, response) => {
          const requestUrl = new URL(
            request.url ?? "/",
            `http://${request.headers.host ?? "127.0.0.1"}`,
          );

          if (
            request.method === "POST" &&
            requestUrl.pathname === "/oauth/token"
          ) {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.from(chunk));
            }

            const params = new URLSearchParams(
              Buffer.concat(chunks).toString("utf8"),
            );
            tokenRequests.push(params);
            const nextResponse = tokenResponses.shift();
            if (!nextResponse) {
              response.statusCode = 500;
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  error: "missing_token_response",
                }),
              );
              return;
            }

            response.statusCode = 200;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                token_type: "Bearer",
                expires_in: 3600,
                ...nextResponse,
              }),
            );
            return;
          }

          const discoveryMatch = /^\/([^/]+)\/\$discovery\/rest$/.exec(
            requestUrl.pathname,
          );
          if (request.method === "GET" && discoveryMatch) {
            const service = discoveryMatch[1]!;
            const version = requestUrl.searchParams.get("version") ?? "v1";
            const authorizationHeader =
              typeof request.headers.authorization === "string"
                ? request.headers.authorization
                : Array.isArray(request.headers.authorization)
                  ? (request.headers.authorization[0] ?? "")
                  : "";
            if (authorizationHeader.length > 0) {
              discoveryAuthorizations.push(authorizationHeader);
            }

            const scope =
              discoveryScopes.get(`${service}:${version}`) ??
              `https://example.test/auth/${service}`;
            response.statusCode = 200;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                name: service,
                version,
                title: `${service} API`,
                description: `Test ${service} API`,
                rootUrl: `${baseUrl}/`,
                servicePath: `${service}/${version}/`,
                auth: {
                  oauth2: {
                    scopes: {
                      [scope]: {
                        description: `${service} scope`,
                      },
                    },
                  },
                },
                methods: {
                  list: {
                    id: `${service}.list`,
                    path: "items",
                    httpMethod: "GET",
                    response: {
                      $ref: "ListResponse",
                    },
                  },
                },
                schemas: {
                  ListResponse: {
                    id: "ListResponse",
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "string",
                        },
                      },
                    },
                  },
                },
              }),
            );
            return;
          }

          response.statusCode = 404;
          response.end();
        });

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Failed to bind Google workspace test server"));
            return;
          }

          baseUrl = `http://127.0.0.1:${address.port}`;
          resolve({
            baseUrl,
            tokenEndpoint: `${baseUrl}/oauth/token`,
            discoveryUrl: ({ service, version, scope }) => {
              discoveryScopes.set(`${service}:${version}`, scope);
              return `${baseUrl}/${service}/$discovery/rest?version=${encodeURIComponent(version)}`;
            },
            queueTokenResponse: (tokenResponse) => {
              tokenResponses.push(tokenResponse);
            },
            tokenRequests,
            discoveryAuthorizations,
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

const upsertLocalSecret = (
  runtime: ExecutorRuntime,
  input: {
    id: string;
    name: string;
    purpose: "oauth_refresh_token" | "oauth_client_info" | "oauth_access_token";
    value: string;
  },
) =>
  runtime.storage.executorState.secretMaterials.upsert({
    id: SecretMaterialIdSchema.make(input.id),
    providerId: "local",
    handle: input.id,
    name: input.name,
    purpose: input.purpose,
    value: input.value,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

const createPersistedGoogleSource = (input: {
  runtime: ExecutorRuntime;
  name: string;
  namespace: string;
  service: string;
  version: string;
  discoveryUrl: string;
  scopes: ReadonlyArray<string>;
  auth:
    | {
        kind: "none";
      }
    | {
        kind: "provider_grant_ref";
        grantId: ReturnType<typeof ProviderAuthGrantIdSchema.make>;
        providerKey: string;
        requiredScopes: ReadonlyArray<string>;
        headerName: string;
        prefix: string;
      };
}) =>
  Effect.gen(function* () {
    const installation = input.runtime.localInstallation;
    const source = yield* createSourceFromPayload({
      workspaceId: installation.workspaceId,
      sourceId: SourceIdSchema.make(`src_${crypto.randomUUID()}`),
      payload: {
        name: input.name,
        kind: "google_discovery",
        endpoint: input.discoveryUrl,
        namespace: input.namespace,
        binding: {
          service: input.service,
          version: input.version,
          discoveryUrl: input.discoveryUrl,
          scopes: [...input.scopes],
        },
        importAuthPolicy: "reuse_runtime",
        importAuth: { kind: "none" },
        auth: input.auth as any,
        status: "connected",
        enabled: true,
      },
      now: Date.now(),
    });

    return yield* persistSource(input.runtime.storage.executorState, source, {
      actorAccountId: installation.accountId,
    }).pipe((effect) => provideExecutorRuntime(effect, input.runtime));
  });

const expectLeft = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.either(effect).pipe(
    Effect.flatMap((result) =>
      Either.isLeft(result)
        ? Effect.succeed(result.left)
        : Effect.fail(
            runtimeEffectError(
              "executor-runtime.test",
              "Expected effect to fail",
            ),
          ),
    ),
  );

const invokeWorkspaceTool = <A>(input: {
  runtime: ExecutorRuntime;
  path: ToolPath;
  args: unknown;
}) =>
  provideExecutorRuntime(
    Effect.gen(function* () {
      const installation = input.runtime.localInstallation;
      const resolveEnvironment = yield* RuntimeExecutionResolverService;
      const environment = yield* resolveEnvironment({
        workspaceId: installation.workspaceId,
        accountId: installation.accountId,
        executionId: ExecutionIdSchema.make(`exec_tool_${crypto.randomUUID()}`),
      });

      return (yield* environment.toolInvoker.invoke({
        path: input.path,
        args: input.args,
      })) as A;
    }),
    input.runtime,
  );

describe("executor-runtime", () => {
  it.scoped(
    "writes local source changes through executor.jsonc",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "executor-local-config-runtime-",
        });
        const homeConfigPath = join(workspaceRoot, ".executor-home.jsonc");
        const homeStateDirectory = join(workspaceRoot, ".executor-home-state");
        const runtime = yield* Effect.acquireRelease(
          createExecutorRuntime({
            workspaceRoot,
            homeConfigPath,
            homeStateDirectory,
          }),
          (createdRuntime) =>
            Effect.promise(() => createdRuntime.close()).pipe(Effect.orDie),
        );
        const openApiServer = yield* makeOpenApiSpecServer;
        const installation = runtime.localInstallation;

        const createdSource = yield* withExecutorApiClient(
          { runtime, accountId: installation.accountId },
          (client) =>
            client.sources.create({
              path: { workspaceId: installation.workspaceId },
              payload: {
                name: "GitHub",
                kind: "openapi",
                endpoint: openApiServer.baseUrl,
                namespace: "github",
                binding: {
                  specUrl: openApiServer.specUrl,
                  defaultHeaders: null,
                },
                auth: { kind: "none" },
              },
            }),
        );

        const configPath = join(workspaceRoot, ".executor", "executor.jsonc");
        const createdConfig = JSON.parse(
          yield* fs.readFileString(configPath, "utf8"),
        ) as {
          sources?: Record<
            string,
            { kind: string; connection: { endpoint: string } }
          >;
        };
        expect(createdConfig.sources?.github?.kind).toBe("openapi");
        expect(createdConfig.sources?.github?.connection.endpoint).toBe(
          openApiServer.baseUrl,
        );

        const removed = yield* withExecutorApiClient(
          { runtime, accountId: installation.accountId },
          (client) =>
            client.sources.remove({
              path: {
                workspaceId: installation.workspaceId,
                sourceId: createdSource.id,
              },
            }),
        );
        expect(removed.removed).toBe(true);

        const removedConfig = JSON.parse(
          yield* fs.readFileString(configPath, "utf8"),
        ) as {
          sources?: Record<string, unknown>;
        };
        expect(removedConfig.sources?.github).toBeUndefined();
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    60_000,
  );

  it.scoped("manages local secrets through provider-backed metadata rows", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime;

      const created = yield* withExecutorApiClient({ runtime }, (client) =>
        client.local.createSecret({
          payload: {
            name: "GitHub PAT",
            value: "ghp_test_token",
            providerId: "local",
          },
        }),
      );

      expect(created.providerId).toBe("local");

      const listed = yield* withExecutorApiClient({ runtime }, (client) =>
        client.local.listSecrets({}),
      );
      expect(listed).toEqual([
        expect.objectContaining({
          id: created.id,
          providerId: "local",
          name: "GitHub PAT",
        }),
      ]);

      const updated = yield* withExecutorApiClient({ runtime }, (client) =>
        client.local.updateSecret({
          path: { secretId: created.id },
          payload: {
            name: "GitHub PAT Updated",
            value: "ghp_test_token_v2",
          },
        }),
      );
      expect(updated.providerId).toBe("local");
      expect(updated.name).toBe("GitHub PAT Updated");

      const storedSecret =
        yield* runtime.storage.executorState.secretMaterials.getById(
          SecretMaterialIdSchema.make(created.id),
        );
      assertTrue(Option.isSome(storedSecret));
      expect(storedSecret.value.providerId).toBe("local");
      expect(storedSecret.value.value).toBe("ghp_test_token_v2");

      const removed = yield* withExecutorApiClient({ runtime }, (client) =>
        client.local.deleteSecret({
          path: { secretId: created.id },
        }),
      );
      expect(removed.removed).toBe(true);
    }),
  );

  it.scoped(
    "reports safe secret storage options for the current platform",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;

        const config = yield* withExecutorApiClient({ runtime }, (client) =>
          client.local.config({}),
        );

        const keychainProvider =
          config.secretProviders.find(
            (provider) => provider.id === "keychain",
          ) ?? null;

        if (process.platform === "linux") {
          expect(config.defaultSecretStoreProvider).toBe("local");
          expect(keychainProvider?.canStore).toBe(false);
          return;
        }

        if (process.platform === "darwin") {
          expect(keychainProvider?.canStore).toBe(true);
          return;
        }

        expect(keychainProvider).toBeNull();
      }),
  );

  it.scoped(
    "exposes shared local admin operations through executor tools",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const openApiServer = yield* makeOpenApiSpecServer;
        const installation = runtime.localInstallation;
        const createdSource = yield* withExecutorApiClient(
          { runtime, accountId: installation.accountId },
          (client) =>
            client.sources.create({
              path: {
                workspaceId: installation.workspaceId,
              },
              payload: {
                name: "GitHub",
                kind: "openapi",
                endpoint: openApiServer.baseUrl,
                status: "connected",
                enabled: true,
                namespace: "github",
                importAuthPolicy: "reuse_runtime",
                binding: {
                  specUrl: openApiServer.specUrl,
                  defaultHeaders: null,
                },
                importAuth: { kind: "none" },
                auth: { kind: "none" },
              },
            }),
        );

        const localInstallation = yield* invokeWorkspaceTool<{
          workspaceId: string;
          accountId: string;
        }>({
          runtime,
          path: "executor.local.installation.get" as ToolPath,
          args: {},
        });
        expect(localInstallation.workspaceId).toBe(installation.workspaceId);
        expect(localInstallation.accountId).toBe(installation.accountId);

        const localConfig = yield* invokeWorkspaceTool<{
          defaultSecretStoreProvider: string;
          secretProviders: Array<{ id: string }>;
        }>({
          runtime,
          path: "executor.local.config.get" as ToolPath,
          args: {},
        });
        expect(localConfig.secretProviders.length).toBeGreaterThan(0);
        expect(typeof localConfig.defaultSecretStoreProvider).toBe("string");

        const createdSecret = yield* invokeWorkspaceTool<{
          id: string;
          providerId: string;
          name: string | null;
        }>({
          runtime,
          path: "executor.secrets.create" as ToolPath,
          args: {
            name: "Executor Admin Token",
            value: "shh",
            providerId: "local",
          },
        });
        expect(createdSecret.providerId).toBe("local");

        const listedSecrets = yield* invokeWorkspaceTool<
          Array<{ id: string; providerId: string; name: string | null }>
        >({
          runtime,
          path: "executor.secrets.list" as ToolPath,
          args: {},
        });
        expect(
          listedSecrets.some((secret) => secret.id === createdSecret.id),
        ).toBe(true);

        const apiSecrets = yield* withExecutorApiClient(
          { runtime },
          (client) => client.local.listSecrets({}),
        );
        expect(
          apiSecrets.some((secret) => secret.id === createdSecret.id),
        ).toBe(true);

        const createdPolicy = yield* invokeWorkspaceTool<{
          id: string;
          resourcePattern: string;
          approvalMode: string;
        }>({
          runtime,
          path: "executor.policies.create" as ToolPath,
          args: {
            resourcePattern: "github.*",
            effect: "allow",
            approvalMode: "auto",
          },
        });
        expect(createdPolicy.resourcePattern).toBe("github.*");

        const loadedPolicy = yield* invokeWorkspaceTool<{
          id: string;
          resourcePattern: string;
        }>({
          runtime,
          path: "executor.policies.get" as ToolPath,
          args: {
            policyId: createdPolicy.id,
          },
        });
        expect(loadedPolicy.id).toBe(createdPolicy.id);

        const listedPolicies = yield* withExecutorApiClient(
          { runtime, accountId: installation.accountId },
          (client) =>
            client.policies.list({
              path: {
                workspaceId: installation.workspaceId,
              },
            }),
        );
        expect(
          listedPolicies.some((policy) => policy.id === createdPolicy.id),
        ).toBe(true);

        const listedSources = yield* invokeWorkspaceTool<Array<{ id: string }>>(
          {
            runtime,
            path: "executor.sources.list" as ToolPath,
            args: {},
          },
        );
        expect(
          listedSources.some((source) => source.id === createdSource.id),
        ).toBe(true);

        const loadedSource = yield* invokeWorkspaceTool<{
          id: string;
          name: string;
        }>({
          runtime,
          path: "executor.sources.get" as ToolPath,
          args: {
            sourceId: createdSource.id,
          },
        });
        expect(loadedSource.name).toBe("GitHub");

        const removedSource = yield* invokeWorkspaceTool<{ removed: boolean }>({
          runtime,
          path: "executor.sources.remove" as ToolPath,
          args: {
            sourceId: createdSource.id,
          },
        });
        expect(removedSource.removed).toBe(true);

        const apiSources = yield* withExecutorApiClient(
          { runtime, accountId: installation.accountId },
          (client) =>
            client.sources.list({
              path: {
                workspaceId: installation.workspaceId,
              },
            }),
        );
        expect(
          apiSources.some((source) => source.id === createdSource.id),
        ).toBe(false);
      }),
  );

  it.scoped(
    "captures credential requests through the local HTML flow without persisting raw tokens",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const installation = runtime.localInstallation;
        const executionId = ExecutionIdSchema.make("exec_local_credential");
        const sourceId = SourceIdSchema.make("github");
        const interactionSuffix = "executor.sources.add:test";
        const interactionId = ExecutionInteractionIdSchema.make(
          `${executionId}:${interactionSuffix}`,
        );
        const now = Date.now();

        yield* runtime.storage.executorState.executions.insert({
          id: executionId,
          workspaceId: installation.workspaceId,
          createdByAccountId: installation.accountId,
          status: "running",
          code: "return await tools.executor.sources.add(...)",
          resultJson: null,
          errorText: null,
          logsJson: null,
          startedAt: now,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        });

        const localSource = yield* createSourceFromPayload({
          workspaceId: installation.workspaceId,
          sourceId,
          payload: {
            name: "GitHub",
            kind: "openapi",
            endpoint: "https://api.github.com",
            status: "auth_required",
            enabled: true,
            namespace: "github",
            importAuthPolicy: "reuse_runtime",
            binding: {
              specUrl: "https://example.com/github-openapi.yaml",
              defaultHeaders: null,
            },
            importAuth: { kind: "none" },
            auth: { kind: "none" },
          },
          now,
        }).pipe(Effect.orDie);
        yield* persistSource(runtime.storage.executorState, localSource, {
          actorAccountId: installation.accountId,
        }).pipe(
          (effect) => provideExecutorRuntime(effect, runtime),
          Effect.orDie,
        );

        const interactionFiber = yield* Effect.gen(function* () {
          const liveExecutionManager = yield* LiveExecutionManagerService;
          const onElicitation = liveExecutionManager.createOnElicitation({
            executorState: runtime.storage.executorState,
            executionId,
          });

          return yield* onElicitation({
            interactionId: interactionSuffix,
            path: "executor.sources.add" as ToolPath,
            sourceKey: "executor",
            args: {
              kind: "openapi",
              endpoint: "https://api.github.com",
              specUrl: "https://example.com/github-openapi.yaml",
              name: "GitHub",
              workspaceId: installation.workspaceId,
              sourceId,
            },
            elicitation: {
              mode: "url",
              message: "Open the secure credential page to connect GitHub",
              url: `http://127.0.0.1/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/sources/${encodeURIComponent(sourceId)}/credentials?interactionId=${encodeURIComponent(interactionId)}`,
              elicitationId: interactionSuffix,
            },
          });
        }).pipe(
          (effect) => provideExecutorRuntime(effect, runtime),
          Effect.fork,
        );

        const waitForPendingInteraction = (
          remaining: number,
        ): Effect.Effect<Option.Option<ExecutionInteraction>, Error> =>
          runtime.storage.executorState.executionInteractions
            .getPendingByExecutionId(executionId)
            .pipe(
              Effect.flatMap((pendingInteraction) =>
                Option.isSome(pendingInteraction) || remaining <= 0
                  ? Effect.succeed(pendingInteraction)
                  : Effect.yieldNow().pipe(
                      Effect.zipRight(waitForPendingInteraction(remaining - 1)),
                    ),
              ),
            );

        const pendingInteraction = yield* waitForPendingInteraction(20);
        assertTrue(Option.isSome(pendingInteraction));
        expect(pendingInteraction.value.id).toBe(interactionId);

        const page = yield* withExecutorApiRequestHandler(
          { runtime },
          (handleRequest) =>
            Effect.promise(async () => {
              const url = new URL(
                `/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/sources/${encodeURIComponent(sourceId)}/credentials`,
                "http://127.0.0.1",
              );
              url.searchParams.set("interactionId", pendingInteraction.value.id);
              const response = await handleRequest(new Request(url));
              return response.text();
            }),
        );
        expect(page).toContain("Configure Source Access");
        expect(page).toContain("GitHub");
        expect(page).toContain("Continue without auth");

        const submittedPage = yield* withExecutorApiRequestHandler(
          { runtime },
          (handleRequest) =>
            Effect.promise(async () => {
              const url = new URL(
                `/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/sources/${encodeURIComponent(sourceId)}/credentials`,
                "http://127.0.0.1",
              );
              url.searchParams.set("interactionId", pendingInteraction.value.id);
              const response = await handleRequest(
                new Request(url, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({
                    action: "submit",
                    token: "ghp_local_test_token",
                  }),
                }),
              );
              return response.text();
            }),
        );
        expect(submittedPage).toContain("Credential Stored");

        const response = yield* Fiber.join(interactionFiber);
        expect(response.action).toBe("accept");
        expect(response.content?.authKind).toBe("bearer");

        const decodedCredentialSelection =
          decodeSourceCredentialSelectionContent(response.content);
        expect(decodedCredentialSelection.authKind).toBe("bearer");

        const tokenSecretMaterialId = SecretMaterialIdSchema.make(
          decodedCredentialSelection.authKind === "bearer"
            ? decodedCredentialSelection.tokenRef.handle
            : "",
        );
        const storedSecret =
          yield* runtime.storage.executorState.secretMaterials.getById(
            tokenSecretMaterialId,
          );
        assertTrue(Option.isSome(storedSecret));
        expect(
          decodedCredentialSelection.authKind === "bearer"
            ? decodedCredentialSelection.tokenRef.providerId
            : null,
        ).toBe(storedSecret.value.providerId);
        expect(storedSecret.value.value).toBe(
          storedSecret.value.providerId === "local"
            ? "ghp_local_test_token"
            : null,
        );

        const storedInteraction =
          yield* runtime.storage.executorState.executionInteractions.getById(
            pendingInteraction.value.id,
          );
        assertTrue(Option.isSome(storedInteraction));
        expect(storedInteraction.value.responseJson).toContain(
          '"authKind":"bearer"',
        );
        expect(storedInteraction.value.responseJson).not.toContain("tokenRef");
        expect(storedInteraction.value.responseJson).not.toContain(
          "ghp_local_test_token",
        );
      }),
  );

  it.scoped("loads a v1.2.3-style workspace artifact on startup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "executor-runtime-v123-",
      });
      const homeConfigPath = join(workspaceRoot, ".executor-home.jsonc");
      const homeStateDirectory = join(workspaceRoot, ".executor-home-state");
      const configDirectory = join(workspaceRoot, ".executor");
      const configPath = join(configDirectory, "executor.jsonc");
      const sourceId = SourceIdSchema.make("graphql");
      const now = Date.now();

      yield* fs.makeDirectory(configDirectory, { recursive: true });
      yield* fs.writeFileString(
        configPath,
        `{
  "sources": {
    "graphql": {
      "kind": "graphql",
      "name": "GraphQL API",
      "namespace": "graphql",
      "connection": {
        "endpoint": "https://example.com/graphql"
      },
      "binding": {
        "defaultHeaders": null
      }
    }
  }
}
`,
      );

      const context = yield* resolveLocalWorkspaceContext({
        workspaceRoot,
        homeConfigPath,
        homeStateDirectory,
      });
      const installation = deriveLocalInstallation(context);
      const source = yield* createSourceFromPayload({
        workspaceId: installation.workspaceId,
        sourceId,
        payload: {
          name: "GraphQL API",
          kind: "graphql",
          endpoint: "https://example.com/graphql",
          status: "connected",
          enabled: true,
          namespace: "graphql",
          importAuthPolicy: "reuse_runtime",
          binding: {
            defaultHeaders: null,
          },
          importAuth: { kind: "none" },
          auth: { kind: "none" },
        },
        now,
      }).pipe(Effect.orDie);

      const artifact = buildLocalSourceArtifact({
        source,
        syncResult: {
          fragment: createGraphqlCatalogFragment({
            source,
            documents: [
              {
                documentKind: "graphql_introspection",
                documentKey: source.endpoint,
                contentText: '{"__schema":{}}',
                fetchedAt: now,
              },
            ],
            operations: [
              {
                toolId: "viewer",
                title: "Viewer",
                description: "Load the current viewer",
                effect: "read",
                inputSchema: { type: "object", properties: {} },
                outputSchema: {
                  type: "object",
                  properties: { login: { type: "string" } },
                },
                providerData: {
                  kind: "graphql",
                  toolKind: "field",
                  toolId: "viewer",
                  rawToolId: "viewer",
                  group: "query",
                  leaf: "viewer",
                  fieldName: "viewer",
                  operationType: "query",
                  operationName: "ViewerQuery",
                  operationDocument: "query ViewerQuery { viewer { login } }",
                  queryTypeName: "Query",
                  mutationTypeName: null,
                  subscriptionTypeName: null,
                },
              },
            ],
          }),
          importMetadata: createCatalogImportMetadata({
            source,
            adapterKey: "graphql",
          }),
          sourceHash: source.sourceHash,
        },
      });

      yield* writeLocalWorkspaceState({
        context,
        state: {
          version: 1,
          sources: {
            [sourceId]: {
              status: source.status,
              lastError: source.lastError,
              sourceHash: source.sourceHash,
              createdAt: source.createdAt,
              updatedAt: source.updatedAt,
            },
          },
          policies: {},
        },
      });
      yield* writeLocalExecutorStateSnapshot({
        context,
        state: {
          version: 1,
          authArtifacts: [],
          authLeases: [],
          sourceOauthClients: [],
          workspaceOauthClients: [],
          providerAuthGrants: [],
          sourceAuthSessions: [],
          secretMaterials: [],
          executions: [],
          executionInteractions: [],
          executionSteps: [],
        },
      });
      yield* writeLocalSourceArtifact({
        context,
        sourceId,
        artifact,
      });

      const artifactPath = join(
        context.artifactsDirectory,
        "sources",
        `${sourceId}.json`,
      );
      const legacyArtifact = JSON.parse(
        yield* fs.readFileString(artifactPath, "utf8"),
      ) as Record<string, unknown>;
      legacyArtifact.version = 3;
      yield* fs.writeFileString(
        artifactPath,
        `${JSON.stringify(legacyArtifact)}\n`,
      );

      const decodedLegacyArtifact = yield* readLocalSourceArtifact({
        context,
        sourceId,
      }).pipe(Effect.provide(NodeFileSystem.layer));
      expect(decodedLegacyArtifact).not.toBeNull();

      const runtime = yield* Effect.acquireRelease(
        createExecutorRuntime({
          workspaceRoot,
          homeConfigPath,
          homeStateDirectory,
        }),
        (createdRuntime) =>
          Effect.promise(() => createdRuntime.close()).pipe(Effect.orDie),
      );

      const inspection = yield* withExecutorApiClient(
        { runtime, accountId: installation.accountId },
        (client) =>
          client.sources.inspection({
            path: {
              workspaceId: installation.workspaceId,
              sourceId,
            },
          }),
      );

      expect(inspection.source.id).toBe(sourceId);
      expect(inspection.source.kind).toBe("graphql");
      expect(inspection.toolCount).toBe(1);
      expect(inspection.tools.map((tool) => tool.path)).toContain(
        "graphql.viewer",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.scoped(
    "rebuilds missing connected source artifacts on startup",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const openApiServer = yield* makeOpenApiSpecServer;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "executor-runtime-startup-rebuild-",
        });
        const homeConfigPath = join(workspaceRoot, ".executor-home.jsonc");
        const homeStateDirectory = join(workspaceRoot, ".executor-home-state");
        const context = yield* resolveLocalWorkspaceContext({
          workspaceRoot,
          homeConfigPath,
          homeStateDirectory,
        });
        const installation = deriveLocalInstallation(context);
        const sourceId = SourceIdSchema.make("github");
        const now = Date.now();
        const source = yield* createSourceFromPayload({
          workspaceId: installation.workspaceId,
          sourceId,
          payload: {
            name: "GitHub",
            kind: "openapi",
            endpoint: openApiServer.baseUrl,
            status: "connected",
            enabled: true,
            namespace: "github",
            importAuthPolicy: "reuse_runtime",
            binding: {
              specUrl: openApiServer.specUrl,
              defaultHeaders: null,
            },
            importAuth: { kind: "none" },
            auth: { kind: "none" },
          },
          now,
        }).pipe(Effect.orDie);

        yield* writeProjectLocalExecutorConfig({
          context,
          config: {
            sources: {
              [sourceId]: {
                kind: "openapi",
                name: "GitHub",
                namespace: "github",
                connection: {
                  endpoint: openApiServer.baseUrl,
                },
                binding: {
                  specUrl: openApiServer.specUrl,
                  defaultHeaders: null,
                },
              },
            },
          },
        });
        yield* writeLocalWorkspaceState({
          context,
          state: {
            version: 1,
            sources: {
              [sourceId]: {
                status: source.status,
                lastError: source.lastError,
                sourceHash: source.sourceHash,
                createdAt: source.createdAt,
                updatedAt: source.updatedAt,
              },
            },
            policies: {},
          },
        });

        const runtime = yield* Effect.acquireRelease(
          createExecutorRuntime({
            workspaceRoot,
            homeConfigPath,
            homeStateDirectory,
          }),
          (createdRuntime) =>
            Effect.promise(() => createdRuntime.close()).pipe(Effect.orDie),
        );

        const rebuiltArtifact = yield* readLocalSourceArtifact({
          context,
          sourceId,
        }).pipe(Effect.provide(NodeFileSystem.layer));
        expect(rebuiltArtifact).not.toBeNull();

        const inspection = yield* withExecutorApiClient(
          { runtime, accountId: installation.accountId },
          (client) =>
            client.sources.inspection({
              path: {
                workspaceId: installation.workspaceId,
                sourceId,
              },
            }),
        );
        expect(inspection.tools.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    60_000,
  );

  it.scoped(
    "returns an empty inspection bundle for auth-required sources without a catalog artifact",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const installation = runtime.localInstallation;
        const sourceId = SourceIdSchema.make("googleapis");
        const now = Date.now();

        const localSource = yield* createSourceFromPayload({
          workspaceId: installation.workspaceId,
          sourceId,
          payload: {
            name: "Google Drive",
            kind: "google_discovery",
            endpoint:
              "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
            status: "auth_required",
            enabled: true,
            namespace: "googleapis",
            importAuthPolicy: "reuse_runtime",
            binding: {
              service: "drive",
              version: "v3",
              discoveryUrl:
                "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
              scopes: ["https://www.googleapis.com/auth/drive.readonly"],
            },
            importAuth: { kind: "none" },
            auth: { kind: "none" },
          },
          now,
        }).pipe(Effect.orDie);
        yield* persistSource(runtime.storage.executorState, localSource, {
          actorAccountId: installation.accountId,
        }).pipe(
          (effect) => provideExecutorRuntime(effect, runtime),
          Effect.orDie,
        );

        const inspection = yield* withExecutorApiClient(
          { runtime, accountId: installation.accountId },
          (client) =>
            client.sources.inspection({
              path: {
                workspaceId: installation.workspaceId,
                sourceId,
              },
            }),
        );

        expect(inspection.source.id).toBe(sourceId);
        expect(inspection.source.status).toBe("auth_required");
        expect(inspection.toolCount).toBe(0);
        expect(inspection.tools).toEqual([]);
      }),
  );

  it.scoped(
    "still fails inspection when a connected source is missing its catalog artifact",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const installation = runtime.localInstallation;
        const sourceId = SourceIdSchema.make("googleapis");
        const now = Date.now();

        const localSource = yield* createSourceFromPayload({
          workspaceId: installation.workspaceId,
          sourceId,
          payload: {
            name: "Google Drive",
            kind: "google_discovery",
            endpoint:
              "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
            status: "connected",
            enabled: true,
            namespace: "googleapis",
            importAuthPolicy: "reuse_runtime",
            binding: {
              service: "drive",
              version: "v3",
              discoveryUrl:
                "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
              scopes: ["https://www.googleapis.com/auth/drive.readonly"],
            },
            importAuth: { kind: "none" },
            auth: { kind: "none" },
          },
          now,
        }).pipe(Effect.orDie);
        yield* persistSource(runtime.storage.executorState, localSource, {
          actorAccountId: installation.accountId,
        }).pipe(
          (effect) => provideExecutorRuntime(effect, runtime),
          Effect.orDie,
        );

        const error = yield* expectLeft(
          withExecutorApiClient(
            { runtime, accountId: installation.accountId },
            (client) =>
              client.sources.inspection({
                path: {
                  workspaceId: installation.workspaceId,
                  sourceId,
                },
              }),
          ),
        );

        expect(error.message).toContain(
          "Catalog artifact missing for source googleapis",
        );
      }),
  );

  it.scoped(
    "allows continuing an OpenAPI source credential request without auth",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const installation = runtime.localInstallation;
        const executionId = ExecutionIdSchema.make(
          "exec_local_credential_continue",
        );
        const sourceId = SourceIdSchema.make("github");
        const interactionSuffix = "executor.sources.add:continue";
        const interactionId = ExecutionInteractionIdSchema.make(
          `${executionId}:${interactionSuffix}`,
        );
        const now = Date.now();

        yield* runtime.storage.executorState.executions.insert({
          id: executionId,
          workspaceId: installation.workspaceId,
          createdByAccountId: installation.accountId,
          status: "running",
          code: "return await tools.executor.sources.add(...)",
          resultJson: null,
          errorText: null,
          logsJson: null,
          startedAt: now,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        });

        const localSource = yield* createSourceFromPayload({
          workspaceId: installation.workspaceId,
          sourceId,
          payload: {
            name: "GitHub",
            kind: "openapi",
            endpoint: "https://api.github.com",
            status: "auth_required",
            enabled: true,
            namespace: "github",
            importAuthPolicy: "reuse_runtime",
            binding: {
              specUrl: "https://example.com/github-openapi.yaml",
              defaultHeaders: null,
            },
            importAuth: { kind: "none" },
            auth: { kind: "none" },
          },
          now,
        }).pipe(Effect.orDie);
        yield* persistSource(runtime.storage.executorState, localSource, {
          actorAccountId: installation.accountId,
        }).pipe(
          (effect) => provideExecutorRuntime(effect, runtime),
          Effect.orDie,
        );

        const interactionFiber = yield* Effect.gen(function* () {
          const liveExecutionManager = yield* LiveExecutionManagerService;
          const onElicitation = liveExecutionManager.createOnElicitation({
            executorState: runtime.storage.executorState,
            executionId,
          });

          return yield* onElicitation({
            interactionId: interactionSuffix,
            path: "executor.sources.add" as ToolPath,
            sourceKey: "executor",
            args: {
              kind: "openapi",
              endpoint: "https://api.github.com",
              specUrl: "https://example.com/github-openapi.yaml",
              name: "GitHub",
              workspaceId: installation.workspaceId,
              sourceId,
            },
            elicitation: {
              mode: "url",
              message: "Open the secure credential page to connect GitHub",
              url: `http://127.0.0.1/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/sources/${encodeURIComponent(sourceId)}/credentials?interactionId=${encodeURIComponent(interactionId)}`,
              elicitationId: interactionSuffix,
            },
          });
        }).pipe(
          (effect) => provideExecutorRuntime(effect, runtime),
          Effect.fork,
        );

        const waitForPendingInteraction = (
          remaining: number,
        ): Effect.Effect<Option.Option<ExecutionInteraction>, Error> =>
          runtime.storage.executorState.executionInteractions
            .getPendingByExecutionId(executionId)
            .pipe(
              Effect.flatMap((pendingInteraction) =>
                Option.isSome(pendingInteraction) || remaining <= 0
                  ? Effect.succeed(pendingInteraction)
                  : Effect.yieldNow().pipe(
                      Effect.zipRight(waitForPendingInteraction(remaining - 1)),
                    ),
              ),
            );

        const pendingInteraction = yield* waitForPendingInteraction(20);
        assertTrue(Option.isSome(pendingInteraction));

        const submitted = yield* submitSourceCredentialInteraction({
          workspaceId: installation.workspaceId,
          sourceId,
          interactionId: pendingInteraction.value.id,
          action: "continue",
        }).pipe((effect) => provideExecutorRuntime(effect, runtime));

        expect(submitted.kind).toBe("continued");

        const response = yield* Fiber.join(interactionFiber);
        expect(response.action).toBe("accept");
        expect(response.content).toEqual({
          authKind: "none",
        });

        const storedInteraction =
          yield* runtime.storage.executorState.executionInteractions.getById(
            pendingInteraction.value.id,
          );
        assertTrue(Option.isSome(storedInteraction));
        expect(storedInteraction.value.responseJson).toContain(
          '"authKind":"none"',
        );
        expect(storedInteraction.value.responseJson).not.toContain("tokenRef");
      }),
  );

  it.scoped(
    "decodes GraphQL source credential interactions for the local credential flow",
    () =>
      Effect.gen(function* () {
        const executionId = ExecutionIdSchema.make(
          "exec_local_graphql_credential_continue",
        );
        const workspaceId = "ws_local_graphql" as const;
        const sourceId = SourceIdSchema.make("graphql_api");
        const now = Date.now();
        const decoded = decodeSourceCredentialInteraction({
          id: ExecutionInteractionIdSchema.make(
            "exec_local_graphql_credential_continue:executor.sources.add:graphql-continue",
          ),
          executionId,
          status: "pending",
          purpose: "source_connect_oauth2",
          payloadJson: JSON.stringify({
            path: "executor.sources.add",
            args: {
              kind: "graphql",
              endpoint: "https://example.com/graphql",
              name: "GraphQL API",
              namespace: "graphql",
              workspaceId,
              sourceId,
            },
            elicitation: {
              mode: "url",
              message: "Open the secure credential page to connect GraphQL API",
            },
          }),
          responseJson: null,
          responsePrivateJson: null,
          createdAt: now,
          updatedAt: now,
        });

        expect(decoded).not.toBeNull();
        expect(decoded?.workspaceId).toBe(workspaceId);
        expect(decoded?.sourceId).toBe(sourceId);
        expect(decoded?.message).toContain("GraphQL API");
      }),
  );

  it.scoped(
    "reuses existing Google provider grants for single connects and clears orphan state",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const googleServer = yield* makeGoogleWorkspaceTestServer;
        const installation = runtime.localInstallation;

        const oauthClient = yield* withExecutorApiClient(
          { runtime },
          (client) =>
            client.sources.createWorkspaceOauthClient({
              path: {
                workspaceId: installation.workspaceId,
              },
              payload: {
                providerKey: "google_workspace",
                label: "Local Google Workspace Client",
                oauthClient: {
                  clientId: "google-client-id",
                  clientSecret: "google-client-secret",
                },
              },
            }),
        );

        const refreshSecretId = "sec_google_refresh_single_reuse";
        yield* upsertLocalSecret(runtime, {
          id: refreshSecretId,
          name: "Google Refresh Token",
          purpose: "oauth_refresh_token",
          value: "refresh-token-reuse",
        });

        const grantId = ProviderAuthGrantIdSchema.make(
          `provider_grant_${crypto.randomUUID()}`,
        );
        yield* runtime.storage.executorState.providerAuthGrants.upsert({
          id: grantId,
          workspaceId: installation.workspaceId,
          actorAccountId: installation.accountId,
          providerKey: "google_workspace",
          oauthClientId: oauthClient.id,
          tokenEndpoint: googleServer.tokenEndpoint,
          clientAuthentication: "client_secret_post",
          headerName: "Authorization",
          prefix: "Bearer ",
          refreshToken: {
            providerId: "local",
            handle: refreshSecretId,
          },
          grantedScopes: ["scope:drive.readonly"],
          lastRefreshedAt: null,
          orphanedAt: 123,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        googleServer.queueTokenResponse({
          access_token: "reuse-access-token",
          scope: "scope:drive.readonly",
        });

        const result = yield* withExecutorApiClient({ runtime }, (client) =>
          client.sources.connect({
            path: {
              workspaceId: installation.workspaceId,
            },
            payload: {
              kind: "google_discovery",
              workspaceOauthClientId: oauthClient.id,
              service: "drive",
              version: "v3",
              discoveryUrl: googleServer.discoveryUrl({
                service: "drive",
                version: "v3",
                scope: "scope:drive.readonly",
              }),
              scopes: ["scope:drive.readonly"],
              name: "Drive",
              namespace: "google.drive",
            },
          }),
        );

        expect(result.kind).toBe("connected");
        if (result.kind !== "connected") {
          throw new Error(`Expected connected result, received ${result.kind}`);
        }
        expect(result.source.auth).toEqual({
          kind: "provider_grant_ref",
          grantId,
          providerKey: "google_workspace",
          requiredScopes: ["scope:drive.readonly"],
          headerName: "Authorization",
          prefix: "Bearer ",
        });

        const storedGrant =
          yield* runtime.storage.executorState.providerAuthGrants.getById(grantId);
        assertTrue(Option.isSome(storedGrant));
        expect(storedGrant.value.orphanedAt).toBeNull();
        expect(googleServer.discoveryAuthorizations).toContain(
          "Bearer reuse-access-token",
        );
      }),
    60_000,
  );

  it.scoped(
    "uses the app callback redirect for browser-started Google single-source OAuth",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const googleServer = yield* makeGoogleWorkspaceTestServer;
        const installation = runtime.localInstallation;

        const oauthClient = yield* withExecutorApiClient(
          { runtime },
          (client) =>
            client.sources.createWorkspaceOauthClient({
              path: {
                workspaceId: installation.workspaceId,
              },
              payload: {
                providerKey: "google_workspace",
                label: "Local Google Workspace Client",
                oauthClient: {
                  clientId: "google-client-id",
                  clientSecret: "google-client-secret",
                },
              },
            }),
        );

        const result = yield* withExecutorApiClient({ runtime }, (client) =>
          client.sources.connect({
            path: {
              workspaceId: installation.workspaceId,
            },
            payload: {
              kind: "google_discovery",
              workspaceOauthClientId: oauthClient.id,
              service: "gmail",
              version: "v1",
              discoveryUrl: googleServer.discoveryUrl({
                service: "gmail",
                version: "v1",
                scope: "scope:gmail.readonly",
              }),
              scopes: ["scope:gmail.readonly"],
              name: "Gmail",
              namespace: "google.gmail",
            },
          }),
        );

        expect(result.kind).toBe("oauth_required");
        if (result.kind !== "oauth_required") {
          throw new Error(
            `Expected oauth_required result, received ${result.kind}`,
          );
        }

        const redirectUri = new URL(result.authorizationUrl).searchParams.get(
          "redirect_uri",
        );
        expect(redirectUri).not.toBeNull();
        expect(new URL(redirectUri!).pathname).toBe(
          `/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/oauth/provider/callback`,
        );
        expect(result.source.status).toBe("auth_required");
      }),
    60_000,
  );

  it.scoped(
    "reuses existing Google provider grants for batch connects and clears orphan state",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const googleServer = yield* makeGoogleWorkspaceTestServer;
        const installation = runtime.localInstallation;

        const oauthClient = yield* withExecutorApiClient(
          { runtime },
          (client) =>
            client.sources.createWorkspaceOauthClient({
              path: {
                workspaceId: installation.workspaceId,
              },
              payload: {
                providerKey: "google_workspace",
                label: "Local Google Workspace Client",
                oauthClient: {
                  clientId: "google-client-id",
                  clientSecret: "google-client-secret",
                },
              },
            }),
        );

        const refreshSecretId = "sec_google_refresh_reuse";
        yield* upsertLocalSecret(runtime, {
          id: refreshSecretId,
          name: "Google Refresh Token",
          purpose: "oauth_refresh_token",
          value: "refresh-token-reuse",
        });

        const grantId = ProviderAuthGrantIdSchema.make(
          `provider_grant_${crypto.randomUUID()}`,
        );
        yield* runtime.storage.executorState.providerAuthGrants.upsert({
          id: grantId,
          workspaceId: installation.workspaceId,
          actorAccountId: installation.accountId,
          providerKey: "google_workspace",
          oauthClientId: oauthClient.id,
          tokenEndpoint: googleServer.tokenEndpoint,
          clientAuthentication: "client_secret_post",
          headerName: "Authorization",
          prefix: "Bearer ",
          refreshToken: {
            providerId: "local",
            handle: refreshSecretId,
          },
          grantedScopes: ["scope:gmail.readonly", "scope:calendar.readonly"],
          lastRefreshedAt: null,
          orphanedAt: 123,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        googleServer.queueTokenResponse({
          access_token: "reuse-access-token",
          scope: "scope:gmail.readonly scope:calendar.readonly",
        });
        googleServer.queueTokenResponse({
          access_token: "reuse-access-token",
          scope: "scope:gmail.readonly scope:calendar.readonly",
        });

        const result = yield* withExecutorApiClient({ runtime }, (client) =>
          client.sources.connectBatch({
            path: {
              workspaceId: installation.workspaceId,
            },
            payload: {
              workspaceOauthClientId: oauthClient.id,
              sources: [
                {
                  service: "gmail",
                  version: "v1",
                  discoveryUrl: googleServer.discoveryUrl({
                    service: "gmail",
                    version: "v1",
                    scope: "scope:gmail.readonly",
                  }),
                  scopes: ["scope:gmail.readonly"],
                  name: "Gmail",
                  namespace: "google.gmail",
                },
                {
                  service: "calendar",
                  version: "v3",
                  discoveryUrl: googleServer.discoveryUrl({
                    service: "calendar",
                    version: "v3",
                    scope: "scope:calendar.readonly",
                  }),
                  scopes: ["scope:calendar.readonly"],
                  name: "Calendar",
                  namespace: "google.calendar",
                },
              ],
            },
          }),
        );

        expect(result.providerOauthSession).toBeNull();
        expect(result.results).toHaveLength(2);
        expect(
          result.results.every((entry) => entry.status === "connected"),
        ).toBe(true);
        expect(
          result.results.every(
            (entry) => entry.source.auth.kind === "provider_grant_ref",
          ),
        ).toBe(true);

        const storedGrant =
          yield* runtime.storage.executorState.providerAuthGrants.getById(grantId);
        assertTrue(Option.isSome(storedGrant));
        expect(storedGrant.value.orphanedAt).toBeNull();
        expect(googleServer.tokenRequests.length).toBeGreaterThanOrEqual(1);
        expect(
          googleServer.discoveryAuthorizations.every(
            (authorization) => authorization === "Bearer reuse-access-token",
          ),
        ).toBe(true);
      }),
    60_000,
  );

  it.scoped(
    "uses the app callback redirect for browser-started Google batch OAuth",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const googleServer = yield* makeGoogleWorkspaceTestServer;
        const installation = runtime.localInstallation;

        const oauthClient = yield* withExecutorApiClient(
          { runtime },
          (client) =>
            client.sources.createWorkspaceOauthClient({
              path: {
                workspaceId: installation.workspaceId,
              },
              payload: {
                providerKey: "google_workspace",
                label: "Local Google Workspace Client",
                oauthClient: {
                  clientId: "google-client-id",
                  clientSecret: "google-client-secret",
                },
              },
            }),
        );

        const result = yield* withExecutorApiClient({ runtime }, (client) =>
          client.sources.connectBatch({
            path: {
              workspaceId: installation.workspaceId,
            },
            payload: {
              workspaceOauthClientId: oauthClient.id,
              sources: [
                {
                  service: "gmail",
                  version: "v1",
                  discoveryUrl: googleServer.discoveryUrl({
                    service: "gmail",
                    version: "v1",
                    scope: "scope:gmail.readonly",
                  }),
                  scopes: ["scope:gmail.readonly"],
                  name: "Gmail",
                  namespace: "google.gmail",
                },
              ],
            },
          }),
        );

        expect(result.providerOauthSession).not.toBeNull();
        const redirectUri = new URL(
          result.providerOauthSession!.authorizationUrl,
        ).searchParams.get("redirect_uri");

        expect(redirectUri).not.toBeNull();
        expect(new URL(redirectUri!).pathname).toBe(
          `/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/oauth/provider/callback`,
        );
      }),
    60_000,
  );

  it.scoped(
    "preserves the existing provider refresh token when callback expansion omits refresh_token",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const googleServer = yield* makeGoogleWorkspaceTestServer;
        const installation = runtime.localInstallation;

        const oauthClient = yield* withExecutorApiClient(
          { runtime },
          (client) =>
            client.sources.createWorkspaceOauthClient({
              path: {
                workspaceId: installation.workspaceId,
              },
              payload: {
                providerKey: "google_workspace",
                label: "Local Google Workspace Client",
                oauthClient: {
                  clientId: "google-client-id",
                  clientSecret: "google-client-secret",
                },
              },
            }),
        );

        const preservedRefreshSecretId = "sec_google_refresh_preserved";
        yield* upsertLocalSecret(runtime, {
          id: preservedRefreshSecretId,
          name: "Preserved Google Refresh Token",
          purpose: "oauth_refresh_token",
          value: "refresh-token-preserved",
        });

        const source = yield* createPersistedGoogleSource({
          runtime,
          name: "Drive",
          namespace: "google.drive",
          service: "drive",
          version: "v3",
          discoveryUrl: googleServer.discoveryUrl({
            service: "drive",
            version: "v3",
            scope: "scope:drive.readonly",
          }),
          scopes: ["scope:drive.readonly"],
          auth: {
            kind: "none",
          },
        });

        const grantId = ProviderAuthGrantIdSchema.make(
          `provider_grant_${crypto.randomUUID()}`,
        );
        yield* runtime.storage.executorState.providerAuthGrants.upsert({
          id: grantId,
          workspaceId: installation.workspaceId,
          actorAccountId: installation.accountId,
          providerKey: "google_workspace",
          oauthClientId: oauthClient.id,
          tokenEndpoint: googleServer.tokenEndpoint,
          clientAuthentication: "client_secret_post",
          headerName: "Authorization",
          prefix: "Bearer ",
          refreshToken: {
            providerId: "local",
            handle: preservedRefreshSecretId,
          },
          grantedScopes: ["scope:gmail.readonly"],
          lastRefreshedAt: null,
          orphanedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const sessionId = SourceAuthSessionIdSchema.make(
          `src_auth_${crypto.randomUUID()}`,
        );
        const state = `provider-state-${crypto.randomUUID()}`;
        yield* runtime.storage.executorState.sourceAuthSessions.upsert({
          id: sessionId,
          workspaceId: installation.workspaceId,
          sourceId: SourceIdSchema.make(
            `oauth_provider_${crypto.randomUUID()}`,
          ),
          actorAccountId: installation.accountId,
          credentialSlot: "runtime",
          executionId: null,
          interactionId: null,
          providerKind: "oauth2_provider_batch",
          status: "pending",
          state,
          sessionDataJson: JSON.stringify({
            kind: "provider_oauth_batch",
            providerKey: "google_workspace",
            authorizationEndpoint:
              "https://accounts.google.com/o/oauth2/v2/auth",
            tokenEndpoint: googleServer.tokenEndpoint,
            redirectUri: `${googleServer.baseUrl}/oauth/callback`,
            oauthClientId: oauthClient.id,
            clientAuthentication: "client_secret_post",
            scopes: ["scope:gmail.readonly", "scope:drive.readonly"],
            headerName: "Authorization",
            prefix: "Bearer ",
            authorizationParams: {
              access_type: "offline",
              prompt: "consent",
              include_granted_scopes: "true",
            },
            targetSources: [
              {
                sourceId: source.id,
                requiredScopes: ["scope:drive.readonly"],
              },
            ],
            codeVerifier: "pkce-verifier",
            authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`,
          }),
          errorText: null,
          completedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        googleServer.queueTokenResponse({
          access_token: "authorization-code-access-token",
          scope: "scope:gmail.readonly scope:drive.readonly",
        });
        googleServer.queueTokenResponse({
          access_token: "post-callback-sync-access-token",
          scope: "scope:gmail.readonly scope:drive.readonly",
        });

        const callbackPage = yield* withExecutorApiClient(
          { runtime },
          (client) =>
            client.sources.providerOauthComplete({
              path: {
                workspaceId: installation.workspaceId,
              },
              urlParams: {
                state,
                code: "authorization-code",
              },
            }),
        );

        expect(callbackPage).toContain("Connected 1 source");

        const storedGrant =
          yield* runtime.storage.executorState.providerAuthGrants.getById(grantId);
        assertTrue(Option.isSome(storedGrant));
        expect(storedGrant.value.refreshToken).toEqual({
          providerId: "local",
          handle: preservedRefreshSecretId,
        });
        expect(storedGrant.value.grantedScopes).toEqual([
          "scope:gmail.readonly",
          "scope:drive.readonly",
        ]);

        const refreshedSource = yield* withExecutorApiClient(
          { runtime },
          (client) =>
            client.sources.get({
              path: {
                workspaceId: installation.workspaceId,
                sourceId: source.id,
              },
            }),
        );

        expect(refreshedSource.status).toBe("connected");
        expect(refreshedSource.auth).toEqual({
          kind: "provider_grant_ref",
          grantId,
          providerKey: "google_workspace",
          requiredScopes: ["scope:drive.readonly"],
          headerName: "Authorization",
          prefix: "Bearer ",
        });

        expect(
          googleServer.tokenRequests.map((request) =>
            request.get("grant_type"),
          ),
        ).toEqual(["authorization_code", "refresh_token"]);
        expect(googleServer.tokenRequests[1]?.get("refresh_token")).toBe(
          "refresh-token-preserved",
        );
        expect(googleServer.discoveryAuthorizations).toContain(
          "Bearer post-callback-sync-access-token",
        );
      }),
    60_000,
  );

  it.scoped(
    "marks provider grants as orphaned when the last referencing source is removed",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const installation = runtime.localInstallation;
        const oauthClientId = WorkspaceOauthClientIdSchema.make(
          `ws_oauth_client_${crypto.randomUUID()}`,
        );
        const refreshSecretId = "sec_google_refresh_orphan";

        yield* runtime.storage.executorState.workspaceOauthClients.upsert({
          id: oauthClientId,
          workspaceId: installation.workspaceId,
          providerKey: "google_workspace",
          label: "Local Google Workspace Client",
          clientId: "google-client-id",
          clientSecretProviderId: null,
          clientSecretHandle: null,
          clientMetadataJson: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        yield* upsertLocalSecret(runtime, {
          id: refreshSecretId,
          name: "Google Refresh Token",
          purpose: "oauth_refresh_token",
          value: "refresh-token-orphan",
        });

        const grantId = ProviderAuthGrantIdSchema.make(
          `provider_grant_${crypto.randomUUID()}`,
        );
        yield* runtime.storage.executorState.providerAuthGrants.upsert({
          id: grantId,
          workspaceId: installation.workspaceId,
          actorAccountId: installation.accountId,
          providerKey: "google_workspace",
          oauthClientId,
          tokenEndpoint: "https://example.test/oauth/token",
          clientAuthentication: "client_secret_post",
          headerName: "Authorization",
          prefix: "Bearer ",
          refreshToken: {
            providerId: "local",
            handle: refreshSecretId,
          },
          grantedScopes: ["scope:drive.readonly"],
          lastRefreshedAt: null,
          orphanedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const source = yield* createPersistedGoogleSource({
          runtime,
          name: "Drive",
          namespace: "google.drive",
          service: "drive",
          version: "v3",
          discoveryUrl: "https://example.test/drive/$discovery/rest?version=v3",
          scopes: ["scope:drive.readonly"],
          auth: {
            kind: "provider_grant_ref",
            grantId,
            providerKey: "google_workspace",
            requiredScopes: ["scope:drive.readonly"],
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        });

        const removed = yield* withExecutorApiClient({ runtime }, (client) =>
          client.sources.remove({
            path: {
              workspaceId: installation.workspaceId,
              sourceId: source.id,
            },
          }),
        );

        expect(removed.removed).toBe(true);

        const storedGrant =
          yield* runtime.storage.executorState.providerAuthGrants.getById(grantId);
        assertTrue(Option.isSome(storedGrant));
        expect(storedGrant.value.orphanedAt).not.toBeNull();
      }),
  );

  it.scoped(
    "revokes shared provider grants through the API and disconnects linked sources",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime;
        const installation = runtime.localInstallation;
        const oauthClientId = WorkspaceOauthClientIdSchema.make(
          `ws_oauth_client_${crypto.randomUUID()}`,
        );
        const refreshSecretId = "sec_google_refresh_revoke";

        yield* runtime.storage.executorState.workspaceOauthClients.upsert({
          id: oauthClientId,
          workspaceId: installation.workspaceId,
          providerKey: "google_workspace",
          label: "Local Google Workspace Client",
          clientId: "google-client-id",
          clientSecretProviderId: null,
          clientSecretHandle: null,
          clientMetadataJson: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        yield* upsertLocalSecret(runtime, {
          id: refreshSecretId,
          name: "Google Refresh Token",
          purpose: "oauth_refresh_token",
          value: "refresh-token-revoke",
        });

        const grantId = ProviderAuthGrantIdSchema.make(
          `provider_grant_${crypto.randomUUID()}`,
        );
        yield* runtime.storage.executorState.providerAuthGrants.upsert({
          id: grantId,
          workspaceId: installation.workspaceId,
          actorAccountId: installation.accountId,
          providerKey: "google_workspace",
          oauthClientId,
          tokenEndpoint: "https://example.test/oauth/token",
          clientAuthentication: "client_secret_post",
          headerName: "Authorization",
          prefix: "Bearer ",
          refreshToken: {
            providerId: "local",
            handle: refreshSecretId,
          },
          grantedScopes: ["scope:drive.readonly", "scope:gmail.readonly"],
          lastRefreshedAt: null,
          orphanedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const driveSource = yield* createPersistedGoogleSource({
          runtime,
          name: "Drive",
          namespace: "google.drive",
          service: "drive",
          version: "v3",
          discoveryUrl: "https://example.test/drive/$discovery/rest?version=v3",
          scopes: ["scope:drive.readonly"],
          auth: {
            kind: "provider_grant_ref",
            grantId,
            providerKey: "google_workspace",
            requiredScopes: ["scope:drive.readonly"],
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        });
        const gmailSource = yield* createPersistedGoogleSource({
          runtime,
          name: "Gmail",
          namespace: "google.gmail",
          service: "gmail",
          version: "v1",
          discoveryUrl: "https://example.test/gmail/$discovery/rest?version=v1",
          scopes: ["scope:gmail.readonly"],
          auth: {
            kind: "provider_grant_ref",
            grantId,
            providerKey: "google_workspace",
            requiredScopes: ["scope:gmail.readonly"],
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        });

        const removed = yield* withExecutorApiClient({ runtime }, (client) =>
          client.sources.removeProviderAuthGrant({
            path: {
              workspaceId: installation.workspaceId,
              grantId,
            },
          }),
        );

        expect(removed.removed).toBe(true);

        const storedGrant =
          yield* runtime.storage.executorState.providerAuthGrants.getById(grantId);
        assertTrue(Option.isNone(storedGrant));

        const storedRefreshSecret =
          yield* runtime.storage.executorState.secretMaterials.getById(
            SecretMaterialIdSchema.make(refreshSecretId),
          );
        assertTrue(Option.isNone(storedRefreshSecret));

        const disconnectedDrive = yield* withExecutorApiClient(
          { runtime },
          (client) =>
            client.sources.get({
              path: {
                workspaceId: installation.workspaceId,
                sourceId: driveSource.id,
              },
            }),
        );
        const disconnectedGmail = yield* withExecutorApiClient(
          { runtime },
          (client) =>
            client.sources.get({
              path: {
                workspaceId: installation.workspaceId,
                sourceId: gmailSource.id,
              },
            }),
        );

        expect(disconnectedDrive.status).toBe("auth_required");
        expect(disconnectedDrive.auth).toEqual({ kind: "none" });
        expect(disconnectedGmail.status).toBe("auth_required");
        expect(disconnectedGmail.auth).toEqual({ kind: "none" });
      }),
  );
});
