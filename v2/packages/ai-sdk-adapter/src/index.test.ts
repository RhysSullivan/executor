import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "@effect/platform";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";
import {
  createInMemoryRuntimeRunClient,
  createRuntimeRunClient,
  makeOpenApiToolProvider,
  makeToolProviderRegistry,
  openApiToolDescriptorsFromManifest,
} from "@executor-v2/engine";
import { makeSourceManagerService } from "@executor-v2/management-api";
import { type ToolArtifactStore } from "@executor-v2/persistence-ports";
import {
  SourceSchema,
  type Source,
  type ToolArtifact,
} from "@executor-v2/schema";
import { makeDenoSubprocessRuntimeAdapter } from "@executor-v2/runtime-deno-subprocess";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/runtime-local-inproc";
import { createExecutorRunClient } from "@executor-v2/sdk";
import type { ExecuteRunResult } from "@executor-v2/sdk";
import { createGateway, generateText, stepCountIs, tool } from "ai";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { z } from "zod";

import { toAiSdkTools } from "./index";

const gateway = createGateway();

const decodeSource = Schema.decodeUnknownSync(SourceSchema);

type GitHubApiTestServer = {
  baseUrl: string;
  requests: Array<{
    path: string;
    accept: string | null;
  }>;
  close: () => Promise<void>;
};

class GitHubApiServerReleaseError extends Data.TaggedError(
  "GitHubApiServerReleaseError",
)<{
  message: string;
}> {}

const jsonResponse = (res: ServerResponse, statusCode: number, body: unknown): void => {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

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

const makeGitHubApiTestServer = Effect.acquireRelease(
  Effect.promise<GitHubApiTestServer>(
    () =>
      new Promise<GitHubApiTestServer>((resolve, reject) => {
        const requests: GitHubApiTestServer["requests"] = [];

        const server = createServer((req, res) => {
          const host = getHeaderValue(req, "host") ?? "127.0.0.1";
          const url = new URL(req.url ?? "/", `http://${host}`);

          if (url.pathname === openApiPath && req.method === "GET") {
            jsonResponse(res, 200, githubOpenApiSpec);
            return;
          }

          if (url.pathname === "/repos/octocat/hello-world" && req.method === "GET") {
            requests.push({
              path: url.pathname,
              accept: getHeaderValue(req, "accept"),
            });

            jsonResponse(res, 200, {
              full_name: "octocat/hello-world",
              stargazers_count: 42,
              private: false,
            });
            return;
          }

          jsonResponse(res, 404, {
            message: "Not Found",
          });
        });

        server.once("error", (error) => {
          reject(error);
        });

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("failed to resolve GitHub API test server address"));
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
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (cause) =>
        new GitHubApiServerReleaseError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.orDie),
);

const openApiPath = "/openapi.json";

const githubOwnerParam = HttpApiSchema.param("owner", Schema.String);
const githubRepoParam = HttpApiSchema.param("repo", Schema.String);

class GitHubReposApi extends HttpApiGroup.make("repos").add(
  HttpApiEndpoint.get("getRepo")`/repos/${githubOwnerParam}/${githubRepoParam}`.addSuccess(
    Schema.Unknown,
  ),
) {}

class GitHubApi extends HttpApi.make("github").add(GitHubReposApi) {}

const githubOpenApiSpec = OpenApi.fromApi(GitHubApi);

const makeGitHubSource = (baseUrl: string): Source =>
  decodeSource({
    id: "src_github",
    workspaceId: "ws_local",
    name: "github",
    kind: "openapi",
    endpoint: baseUrl,
    status: "connected",
    enabled: true,
    configJson: "{}",
    sourceHash: null,
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

const onlyTool = <T extends { toolId: string }>(descriptors: ReadonlyArray<T>): T => {
  if (descriptors.length !== 1) {
    throw new Error(`expected exactly one tool descriptor, got ${descriptors.length}`);
  }
  return descriptors[0]!;
};

const githubRepoLookupCodeFor = (toolId: string): string =>
  `return await tools[${JSON.stringify(toolId)}]({ owner: "octocat", repo: "hello-world" });`;

const createGitHubRepoLookupRunClient = (baseUrl: string) =>
  Effect.gen(function* () {
    const source = makeGitHubSource(baseUrl);

    const openApiSpec = yield* HttpClient.get(`${baseUrl}${openApiPath}`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
      Effect.provide(FetchHttpClient.layer),
    );

    const artifactsByKey = new Map<string, ToolArtifact>();
    const artifactStore: ToolArtifactStore = {
      getBySource: (workspaceId: Source["workspaceId"], sourceId: Source["id"]) =>
        Effect.succeed(
          Option.fromNullable(artifactsByKey.get(`${workspaceId}:${sourceId}`)),
        ),
      upsert: (artifact: ToolArtifact) =>
        Effect.sync(() => {
          artifactsByKey.set(`${artifact.workspaceId}:${artifact.sourceId}`, artifact);
        }),
    };

    const sourceManager = makeSourceManagerService(artifactStore);
    const refreshResult = yield* sourceManager.refreshOpenApiArtifact({
      source,
      openApiSpec,
    });

    const descriptors = yield* openApiToolDescriptorsFromManifest(
      source,
      refreshResult.artifact.manifestJson,
    );
    const githubTool = onlyTool(descriptors);

    return {
      runClient: createRuntimeRunClient({
        runtimeAdapter: makeLocalInProcessRuntimeAdapter(),
        toolProviderRegistry: makeToolProviderRegistry([makeOpenApiToolProvider()]),
        tools: [
          {
            descriptor: githubTool,
            source,
          },
        ],
        defaults: {
          timeoutMs: 30_000,
        },
      }),
      toolId: githubTool.toolId,
    };
  });

describe("toAiSdkTools", () => {
  it.effect(
    "generates a tool call via generateText with a mock executor",
    () =>
      Effect.gen(function* () {
        const executionLog: Array<{ code: string; timeoutMs?: number }> = [];

        const mockResult: ExecuteRunResult = {
          runId: "run-test-123",
          status: "completed",
          result: 42,
        };

        const runClient = createExecutorRunClient(async (input) => {
          executionLog.push({ code: input.code, timeoutMs: input.timeoutMs });
          return mockResult;
        });

        const tools = toAiSdkTools({
          runClient,
          makeTool: (def) => tool(def),
          defaults: { timeoutMs: 30_000 },
        });

        const result = yield* Effect.tryPromise(() =>
          generateText({
            model: gateway("openai/gpt-4o-mini"),
            tools,
            stopWhen: stepCountIs(3),
            system:
              "You have an execute tool that runs JavaScript code. Always use it when asked to run code.",
            prompt:
              'Run this code using the execute tool: console.log("hello")',
          }),
        );

        expect(executionLog.length).toBeGreaterThanOrEqual(1);
        expect(executionLog[0]!.code).toBeTypeOf("string");
        expect(executionLog[0]!.code.length).toBeGreaterThan(0);
        expect(executionLog[0]!.timeoutMs).toBeTypeOf("number");

        const toolCallSteps = result.steps.filter(
          (step) => step.toolCalls.length > 0,
        );
        expect(toolCallSteps.length).toBeGreaterThanOrEqual(1);

        const firstToolCall = toolCallSteps[0]!.toolCalls[0]!;
        expect(firstToolCall.toolName).toBe("execute");
        expect(firstToolCall.input).toHaveProperty("code");

        const toolResultSteps = result.steps.filter(
          (step) => step.toolResults.length > 0,
        );
        expect(toolResultSteps.length).toBeGreaterThanOrEqual(1);
        const toolResult = toolResultSteps[0]!.toolResults[0]!;
        expect(toolResult.toolName).toBe("execute");
        expect(toolResult.output).toMatchObject(mockResult);

        expect(result.text).toBeTypeOf("string");
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "calls a normal AI SDK tool from the execute sandbox",
    () =>
      Effect.gen(function* () {
        const normalToolCalls: Array<{ query: string }> = [];

        const searchDocsTool = tool({
          description: "Search docs by query",
          inputSchema: z.object({
            query: z.string(),
          }),
          execute: async (input: { query: string }) => {
            normalToolCalls.push(input);
            return {
              hits: [`match:${input.query}`],
            };
          },
        });

        const runClient = createInMemoryRuntimeRunClient({
          runtimeAdapter: makeLocalInProcessRuntimeAdapter(),
          tools: {
            search_docs: searchDocsTool,
          },
          defaults: {
            timeoutMs: 30_000,
          },
        });

        const tools = toAiSdkTools({
          runClient,
          makeTool: (def) => def,
        });

        const result = yield* Effect.tryPromise(() =>
          tools.execute.execute({
            code: "return await tools.search_docs({ query: 'codemode adapter integration' });",
          }),
        );

        expect(result.status).toBe("completed");
        expect(result.result).toEqual({
          hits: ["match:codemode adapter integration"],
        });
        expect(normalToolCalls).toEqual([
          {
            query: "codemode adapter integration",
          },
        ]);
      }),
    { timeout: 30_000 },
  );

  it.scoped(
    "loads a GitHub OpenAPI tool and calls it inside the sandbox",
    () =>
      Effect.gen(function* () {
        const server = yield* makeGitHubApiTestServer;
        const { runClient, toolId } = yield* createGitHubRepoLookupRunClient(
          server.baseUrl,
        );

        const tools = toAiSdkTools({
          runClient,
          makeTool: (definition) => definition,
        });

        const result = yield* Effect.tryPromise(() =>
          tools.execute.execute({
            code: githubRepoLookupCodeFor(toolId),
          }),
        );

        expect(result.status).toBe("completed");
        expect(result.result).toMatchObject({
          status: 200,
          body: {
            full_name: "octocat/hello-world",
            stargazers_count: 42,
            private: false,
          },
        });

        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]?.path).toBe("/repos/octocat/hello-world");
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "executes code in a real Deno subprocess via generateText",
    () =>
      Effect.gen(function* () {
        const runtimeAdapter = makeDenoSubprocessRuntimeAdapter({
          defaultTimeoutMs: 10_000,
        });

        const toolProviderRegistry = makeToolProviderRegistry([]);

        const runClient = createRuntimeRunClient({
          runtimeAdapter,
          toolProviderRegistry,
        });

        const tools = toAiSdkTools({
          runClient,
          makeTool: (def) => tool(def),
        });

        const result = yield* Effect.tryPromise(() =>
          generateText({
            model: gateway("openai/gpt-4o-mini"),
            tools,
            stopWhen: stepCountIs(3),
            system: [
              "You have an execute tool that runs JavaScript code in a sandboxed Deno runtime.",
              "Always use it when asked to run code.",
              "The code must use `return` to produce a result value.",
            ].join(" "),
            prompt: "Use the execute tool to compute 2 + 3. The code should be: return 2 + 3;",
          }),
        );

        const toolCallSteps = result.steps.filter(
          (step) => step.toolCalls.length > 0,
        );
        expect(toolCallSteps.length).toBeGreaterThanOrEqual(1);

        const firstToolCall = toolCallSteps[0]!.toolCalls[0]!;
        expect(firstToolCall.toolName).toBe("execute");

        const toolResultSteps = result.steps.filter(
          (step) => step.toolResults.length > 0,
        );
        expect(toolResultSteps.length).toBeGreaterThanOrEqual(1);

        const toolResult = toolResultSteps[0]!.toolResults[0]!;
        expect(toolResult.toolName).toBe("execute");
        expect(toolResult.output).toMatchObject({
          status: "completed",
          result: 5,
        });

        expect(result.text).toBeTypeOf("string");
      }),
    { timeout: 30_000 },
  );
});
