import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import {
  ElicitationResponse,
  FormElicitation,
  createExecutor,
  definePlugin,
  makeTestConfig,
} from "@executor/sdk";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";
import { createExecutionEngine } from "./engine";
import { describeTool, searchTools } from "./tool-invoker";

const codeExecutor = makeQuickJsExecutor();

const RepoInputSchema = {
  type: "object",
  properties: {
    owner: { type: "string" },
    repo: { type: "string" },
  },
  required: ["owner", "repo"],
  additionalProperties: false,
} as const;

const ContactInputSchema = {
  type: "object",
  properties: {
    email: { type: "string" },
  },
  required: ["email"],
  additionalProperties: false,
} as const;

const EmptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const acceptAll = () => Effect.succeed(new ElicitationResponse({ action: "accept" }));

// ---------------------------------------------------------------------------
// Test plugins — each one declares a namespace as a static source with N
// tools. Handlers return static data; the suite only cares about discovery
// + elicitation flow, not real invocation semantics.
// ---------------------------------------------------------------------------

const githubPlugin = definePlugin(() => ({
  id: "github-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "github",
      kind: "in-memory",
      name: "GitHub",
      tools: [
        {
          name: "listRepositoryIssues",
          description: "List issues for a repository",
          inputSchema: RepoInputSchema,
          handler: () => Effect.succeed([]),
        },
        {
          name: "getRepositoryDetails",
          description: "Get repository details including the default branch",
          inputSchema: RepoInputSchema,
          handler: () => Effect.succeed({ defaultBranch: "main" }),
        },
        {
          name: "searchDocs",
          description: "Search GitHub API documentation",
          inputSchema: EmptyInputSchema,
          handler: () => Effect.succeed([]),
        },
      ],
    },
  ],
}));

const crmPlugin = definePlugin(() => ({
  id: "crm-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "crm",
      kind: "in-memory",
      name: "CRM",
      tools: [
        {
          name: "createContact",
          description: "Create a CRM contact record",
          inputSchema: ContactInputSchema,
          handler: () => Effect.succeed({ id: "contact_1" }),
        },
        {
          name: "listContacts",
          description: "List CRM contacts",
          inputSchema: EmptyInputSchema,
          handler: () => Effect.succeed([]),
        },
      ],
    },
  ],
}));

const makeSearchExecutor = () =>
  createExecutor(
    makeTestConfig({ plugins: [githubPlugin(), crmPlugin()] as const }),
  );

describe("tool discovery", () => {
  it.effect("ranks matches using ids, namespaces, camelCase names, and descriptions", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const githubMatches = yield* searchTools(executor, "github issues", 5);
      expect(githubMatches.map((match) => match.path)).toEqual(["github.listRepositoryIssues"]);
      expect(githubMatches[0]?.score ?? 0).toBeGreaterThan(0);

      const repoMatches = yield* searchTools(executor, "repo details", 5);
      expect(repoMatches[0]?.path).toBe("github.getRepositoryDetails");

      const crmMatches = yield* searchTools(executor, "crm create contact", 5);
      expect(crmMatches[0]?.path).toBe("crm.createContact");
      expect(crmMatches[0]?.score ?? 0).toBeGreaterThan(crmMatches[1]?.score ?? 0);
    }),
  );

  it.effect("returns no matches for empty queries instead of listing arbitrary tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const matches = yield* searchTools(executor, "", 5);
      expect(matches).toEqual([]);
    }),
  );

  it.effect("can narrow discovery to a namespace", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const githubOnly = yield* searchTools(executor, "list", 5, {
        namespace: "github",
      });
      expect(githubOnly.map((match) => match.path)).toEqual(["github.listRepositoryIssues"]);

      const crmOnly = yield* searchTools(executor, "list", 5, {
        namespace: "crm",
      });
      expect(crmOnly.map((match) => match.path)).toEqual(["crm.listContacts"]);

      const sandboxResult = yield* Effect.promise(() =>
        createExecutionEngine({ executor, codeExecutor }).execute(
          'return await tools.search({ namespace: "crm", query: "create contact", limit: 5 });',
          { onElicitation: acceptAll },
        ),
      );
      expect(sandboxResult.error).toBeUndefined();
      expect(sandboxResult.result).toEqual([
        expect.objectContaining({ path: "crm.createContact" }),
      ]);
    }),
  );

  it.effect("supports executor-scoped source listing and tool search", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const listed = yield* Effect.promise(() =>
        createExecutionEngine({ executor, codeExecutor }).execute("return await tools.executor.sources.list();", {
          onElicitation: acceptAll,
        }),
      );
      expect(listed.error).toBeUndefined();
      expect(listed.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "github", toolCount: 3 }),
          expect.objectContaining({ id: "crm", toolCount: 2 }),
        ]),
      );

      const searched = yield* Effect.promise(() =>
        createExecutionEngine({ executor, codeExecutor }).execute(
          'return await tools.search({ query: "list contacts", namespace: "crm", limit: 5 });',
          { onElicitation: acceptAll },
        ),
      );
      expect(searched.error).toBeUndefined();
      expect(searched.result).toEqual([expect.objectContaining({ path: "crm.listContacts" })]);
    }),
  );

  it.effect("describes tools with TypeScript previews", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const described = yield* describeTool(executor, "github.listRepositoryIssues");
      expect(described.path).toBe("github.listRepositoryIssues");
      expect(described.name).toBe("listRepositoryIssues");
      expect(described.description).toBe("List issues for a repository");
      expect(described.inputTypeScript).toBe("{ owner: string; repo: string }");
      expect(described.outputTypeScript).toBeUndefined();
      expect(described.typeScriptDefinitions).toBeUndefined();
    }),
  );

  it.effect("rejects malformed discover calls inside the sandbox", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor });

      const invalid = yield* Effect.promise(() =>
        engine.execute(
          [
            "try {",
            '  await tools.search("github issues");',
            '  return "unexpected";',
            "} catch (error) {",
            "  return error instanceof Error ? error.message : String(error);",
            "}",
          ].join("\n"),
          { onElicitation: acceptAll },
        ),
      );
      expect(invalid.error).toBeUndefined();
      expect(String(invalid.result)).toContain(
        "tools.search expects an object: { query?: string; namespace?: string; limit?: number }",
      );

      const emptyQuery = yield* Effect.promise(() =>
        engine.execute('return await tools.search({ query: "", limit: 5 });', {
          onElicitation: acceptAll,
        }),
      );
      expect(emptyQuery.error).toBeUndefined();
      expect(emptyQuery.result).toEqual([]);

      const invalidDescribe = yield* Effect.promise(() =>
        engine.execute(
          [
            "try {",
            '  await tools.describe.tool({ path: "github.listRepositoryIssues", includeSchemas: true });',
            '  return "unexpected";',
            "} catch (error) {",
            "  return error instanceof Error ? error.message : String(error);",
            "}",
          ].join("\n"),
          { onElicitation: acceptAll },
        ),
      );
      expect(invalidDescribe.error).toBeUndefined();
      expect(String(invalidDescribe.result)).toContain(
        "tools.describe.tool no longer accepts includeSchemas",
      );

      const invalidSearch = yield* Effect.promise(() =>
        engine.execute(
          'try { return await tools.search("crm"); } catch (error) { return error instanceof Error ? error.message : String(error); }',
          { onElicitation: acceptAll },
        ),
      );
      expect(invalidSearch.error).toBeUndefined();
      expect(String(invalidSearch.result)).toContain("tools.search expects an object");
    }),
  );
});

// ---------------------------------------------------------------------------
// pause/resume — multiple elicitations in a single execution
// ---------------------------------------------------------------------------

const apiPlugin = definePlugin(() => ({
  id: "api-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "api",
      kind: "in-memory",
      name: "API",
      tools: [
        {
          name: "multiApproval",
          description: "A tool that elicits twice",
          inputSchema: EmptyInputSchema,
          handler: ({ elicit }) =>
            Effect.gen(function* () {
              const r1 = yield* elicit(
                new FormElicitation({
                  message: "First approval",
                  requestedSchema: {},
                }),
              );
              const r2 = yield* elicit(
                new FormElicitation({
                  message: "Second approval",
                  requestedSchema: {},
                }),
              );
              return { first: r1, second: r2 };
            }),
        },
        {
          name: "singleApproval",
          description:
            "A tool that elicits exactly once and then returns a value. Mirrors the shape of a typical `gmail.users.labels.create` style operation: one approval, one side effect, one success response.",
          inputSchema: EmptyInputSchema,
          handler: ({ elicit }) =>
            Effect.gen(function* () {
              const r = yield* elicit(
                new FormElicitation({
                  message: "Only approval",
                  requestedSchema: {},
                }),
              );
              return { ok: true, response: r };
            }),
        },
      ],
    },
  ],
}));

describe("pause/resume with multiple elicitations", () => {
  const makeElicitingExecutor = () =>
    createExecutor(makeTestConfig({ plugins: [apiPlugin()] as const }));

  it.effect(
    "resume does not hang when execution hits a second elicitation",
    () =>
      Effect.gen(function* () {
        const executor = yield* makeElicitingExecutor();
        const engine = createExecutionEngine({ executor, codeExecutor });

        const code = "return await tools.api.multiApproval({});";

        const outcome1 = yield* Effect.promise(() => engine.executeWithPause(code));
        expect(outcome1.status).toBe("paused");
        const paused1 = outcome1 as Extract<typeof outcome1, { status: "paused" }>;
        expect(paused1.execution.elicitationContext.request.message).toBe("First approval");

        // Resume first pause — execution continues to second elicitation.
        // resume() must not hang; it should return (either a new paused
        // result or the completion).
        const outcome2 = yield* Effect.promise(() =>
          Promise.race([
            engine.resume(paused1.execution.id, { action: "accept" }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("resume hung — second elicitation not surfaced")),
                5000,
              ),
            ),
          ]),
        );

        expect(outcome2).not.toBeNull();
      }),
    { timeout: 10000 },
  );

  // Regression: use separate top-level runPromise calls to match HTTP/CLI
  // pause/resume, and a single-elicit tool so no later pause can mask a dead
  // sandbox fiber.
  it("resume returns across separate runPromise boundaries for a single-elicit tool (HTTP-like)", async () => {
    const executor = await Effect.runPromise(makeElicitingExecutor());
    const engine = createExecutionEngine({ executor, codeExecutor });

    const code = "return await tools.api.singleApproval({});";

    const outcome1 = await engine.executeWithPause(code);
    expect(outcome1.status).toBe("paused");
    const paused1 = outcome1 as Extract<typeof outcome1, { status: "paused" }>;
    expect(paused1.execution.elicitationContext.request.message).toBe("Only approval");

    // `execution.fiber` is on `InternalPausedExecution`; the exported
    // `PausedExecution` type doesn't carry it. Cast to read.
    const sandboxFiber = (
      paused1.execution as unknown as {
        readonly fiber: Fiber.Fiber<unknown, unknown>;
      }
    ).fiber;
    const exitProbe = await Effect.runPromise(
      Effect.race(
        Fiber.await(sandboxFiber),
        Effect.map(Effect.sleep("50 millis"), () => "still-running" as const),
      ),
    );
    expect(exitProbe).toBe("still-running");

    const outcome2 = await Promise.race([
      engine.resume(paused1.execution.id, { action: "accept" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("resume hung across runPromise boundaries")), 2000),
      ),
    ]);

    expect(outcome2).not.toBeNull();
    const resumed = outcome2 as NonNullable<typeof outcome2>;
    expect(resumed.status).toBe("completed");
    if (resumed.status === "completed") {
      expect(resumed.result.error).toBeUndefined();
      expect(resumed.result.result).toMatchObject({ ok: true });
    }
  }, 10000);
});
