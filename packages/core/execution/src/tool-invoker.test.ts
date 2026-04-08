import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ElicitationResponse,
  Source,
  createExecutor,
  inMemoryToolsPlugin,
  makeTestConfig,
  tool,
} from "@executor/core";
import { createExecutionEngine } from "./engine";
import { describeTool, searchTools } from "./tool-invoker";

const EmptyInput = Schema.Struct({});
const RepoInput = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
});
const ContactInput = Schema.Struct({
  email: Schema.String,
});

const acceptAll = () => Effect.succeed(new ElicitationResponse({ action: "accept" }));

const makeSearchExecutor = () =>
  Effect.gen(function* () {
    const config = makeTestConfig({
      plugins: [
        inMemoryToolsPlugin({
          namespace: "github",
          tools: [
            tool({
              name: "listRepositoryIssues",
              description: "List issues for a repository",
              inputSchema: RepoInput,
              handler: () => [],
            }),
            tool({
              name: "getRepositoryDetails",
              description: "Get repository details including the default branch",
              inputSchema: RepoInput,
              handler: () => ({ defaultBranch: "main" }),
            }),
            tool({
              name: "searchDocs",
              description: "Search GitHub API documentation",
              inputSchema: EmptyInput,
              handler: () => [],
            }),
          ],
        }),
        inMemoryToolsPlugin({
          namespace: "crm",
          tools: [
            tool({
              name: "createContact",
              description: "Create a CRM contact record",
              inputSchema: ContactInput,
              handler: () => ({ id: "contact_1" }),
            }),
            tool({
              name: "listContacts",
              description: "List CRM contacts",
              inputSchema: EmptyInput,
              handler: () => [],
            }),
          ],
        }),
      ] as const,
    });

    yield* config.sources.registerRuntime(new Source({
      id: "github",
      name: "GitHub",
      kind: "in-memory",
      runtime: true,
      canRemove: false,
      canRefresh: false,
    }));
    yield* config.sources.registerRuntime(new Source({
      id: "crm",
      name: "CRM",
      kind: "in-memory",
      runtime: true,
      canRemove: false,
      canRefresh: false,
    }));

    return yield* createExecutor(config);
  });

describe("tool discovery", () => {
  it.effect("ranks matches using ids, namespaces, camelCase names, and descriptions", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const githubMatches = yield* searchTools(executor, "github issues", 5);
      expect(githubMatches.map((match) => match.path)).toEqual([
        "github.listRepositoryIssues",
      ]);
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
      expect(githubOnly.map((match) => match.path)).toEqual([
        "github.listRepositoryIssues",
      ]);

      const crmOnly = yield* searchTools(executor, "list", 5, {
        namespace: "crm",
      });
      expect(crmOnly.map((match) => match.path)).toEqual([
        "crm.listContacts",
      ]);

      const sandboxResult = yield* Effect.promise(() =>
        createExecutionEngine({ executor }).execute(
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
        createExecutionEngine({ executor }).execute(
          "return await tools.executor.sources.list();",
          { onElicitation: acceptAll },
        ),
      );
      expect(listed.error).toBeUndefined();
      expect(listed.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "github", toolCount: 3 }),
          expect.objectContaining({ id: "crm", toolCount: 2 }),
        ]),
      );

      const searched = yield* Effect.promise(() =>
        createExecutionEngine({ executor }).execute(
          'return await tools.search({ query: "list contacts", namespace: "crm", limit: 5 });',
          { onElicitation: acceptAll },
        ),
      );
      expect(searched.error).toBeUndefined();
      expect(searched.result).toEqual([
        expect.objectContaining({ path: "crm.listContacts" }),
      ]);
    }),
  );

  it.effect("describes tools with TypeScript previews", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();

      const withoutSchemas = yield* describeTool(
        executor,
        "github.listRepositoryIssues",
      );
      expect(withoutSchemas).toEqual({
        path: "github.listRepositoryIssues",
        name: "listRepositoryIssues",
        description: "List issues for a repository",
        inputTypeScript: "{ owner: string; repo: string }",
        outputTypeScript: undefined,
        typeScriptDefinitions: undefined,
      });

      const withSchemas = yield* describeTool(
        executor,
        "github.listRepositoryIssues",
      );
      expect(withSchemas.path).toBe("github.listRepositoryIssues");
      expect(withSchemas.inputTypeScript).toBe(
        "{ owner: string; repo: string }",
      );
      expect(withSchemas.typeScriptDefinitions).toBeUndefined();
      expect(withSchemas.outputTypeScript).toBeUndefined();
    }),
  );

  it.effect("rejects malformed discover calls inside the sandbox", () =>
    Effect.gen(function* () {
      const executor = yield* makeSearchExecutor();
      const engine = createExecutionEngine({ executor });

      const invalid = yield* Effect.promise(() =>
        engine.execute(
          [
            "try {",
            "  await tools.search(\"github issues\");",
            "  return \"unexpected\";",
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
        engine.execute(
          "return await tools.search({ query: \"\", limit: 5 });",
          { onElicitation: acceptAll },
        ),
      );
      expect(emptyQuery.error).toBeUndefined();
      expect(emptyQuery.result).toEqual([]);

      const invalidDescribe = yield* Effect.promise(() =>
        engine.execute(
          [
            "try {",
            "  await tools.describe.tool({ path: \"github.listRepositoryIssues\", includeSchemas: true });",
            "  return \"unexpected\";",
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
      expect(String(invalidSearch.result)).toContain(
        "tools.search expects an object",
      );
    }),
  );
});
