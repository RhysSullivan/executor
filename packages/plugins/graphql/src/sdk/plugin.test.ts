import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import {
  createExecutor,
  makeTestConfig,
  Scope,
  ScopeId,
} from "@executor/sdk";

import { graphqlPlugin } from "./plugin";
import type { IntrospectionResult } from "./introspect";

const TEST_SCOPE = "test-scope";

// ---------------------------------------------------------------------------
// Mock introspection response
// ---------------------------------------------------------------------------

const introspectionResult: IntrospectionResult = {
  __schema: {
    queryType: { name: "Query" },
    mutationType: { name: "Mutation" },
    types: [
      {
        kind: "OBJECT",
        name: "Query",
        description: null,
        fields: [
          {
            name: "hello",
            description: "Say hello",
            args: [
              {
                name: "name",
                description: null,
                type: { kind: "SCALAR", name: "String", ofType: null },
                defaultValue: null,
              },
            ],
            type: { kind: "SCALAR", name: "String", ofType: null },
          },
        ],
        inputFields: null,
        enumValues: null,
      },
      {
        kind: "OBJECT",
        name: "Mutation",
        description: null,
        fields: [
          {
            name: "setGreeting",
            description: "Set greeting message",
            args: [
              {
                name: "message",
                description: null,
                type: {
                  kind: "NON_NULL",
                  name: null,
                  ofType: { kind: "SCALAR", name: "String", ofType: null },
                },
                defaultValue: null,
              },
            ],
            type: { kind: "SCALAR", name: "String", ofType: null },
          },
        ],
        inputFields: null,
        enumValues: null,
      },
      {
        kind: "SCALAR",
        name: "String",
        description: null,
        fields: null,
        inputFields: null,
        enumValues: null,
      },
    ],
  },
};

const introspectionJson = JSON.stringify({ data: introspectionResult });

describe("graphqlPlugin", () => {
  it.effect("registers tools from introspection JSON", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      const result = yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: "test-scope",
        introspectionJson,
        namespace: "test_api",
      });
      expect(result.toolCount).toBe(2);
      expect(result.namespace).toBe("test_api");

      const tools = yield* executor.tools.list();
      const ids = tools.map((t) => t.id);
      expect(ids).toContain("test_api.query.hello");
      expect(ids).toContain("test_api.mutation.setGreeting");
      // static control tool also present
      expect(ids).toContain("graphql.addSource");

      const queryTool = tools.find((t) => t.id === "test_api.query.hello");
      expect(queryTool?.description).toBe("Say hello");

      const mutationTool = tools.find(
        (t) => t.id === "test_api.mutation.setGreeting",
      );
      expect(mutationTool?.description).toBe("Set greeting message");
    }),
  );

  it.effect("removes a source and its tools", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: "test-scope",
        introspectionJson,
        namespace: "removable",
      });

      let tools = yield* executor.tools.list();
      expect(
        tools.filter((t) => t.sourceId === "removable").length,
      ).toBe(2);

      yield* executor.graphql.removeSource("removable", TEST_SCOPE);

      tools = yield* executor.tools.list();
      expect(
        tools.filter((t) => t.sourceId === "removable").length,
      ).toBe(0);

      const source = yield* executor.graphql.getSource(
        "removable",
        TEST_SCOPE,
      );
      expect(source).toBeNull();
    }),
  );

  it.effect("lists sources with the static control source", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: "test-scope",
        introspectionJson,
        namespace: "my_gql",
      });

      const sources = yield* executor.sources.list();
      const dynamic = sources.find((s) => s.id === "my_gql");
      expect(dynamic).toBeDefined();
      expect(dynamic!.kind).toBe("graphql");
      expect(dynamic!.canRemove).toBe(true);
      expect(dynamic!.canEdit).toBe(true);
      expect(dynamic!.runtime).toBe(false);

      const control = sources.find((s) => s.id === "graphql");
      expect(control).toBeDefined();
      expect(control!.runtime).toBe(true);
    }),
  );

  it.effect("mutations require approval via resolveAnnotations", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: "test-scope",
        introspectionJson,
        namespace: "approval_test",
      });

      const tools = yield* executor.tools.list();
      const mutationTool = tools.find(
        (t) => t.id === "approval_test.mutation.setGreeting",
      );
      expect(mutationTool).toBeDefined();
      expect(mutationTool!.annotations?.requiresApproval).toBe(true);
      expect(mutationTool!.annotations?.approvalDescription).toBe(
        "mutation setGreeting",
      );

      const queryTool = tools.find(
        (t) => t.id === "approval_test.query.hello",
      );
      expect(queryTool).toBeDefined();
      expect(queryTool!.annotations?.requiresApproval).toBeFalsy();
    }),
  );

  it.effect("updateSource patches endpoint/headers without re-registering", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: "test-scope",
        introspectionJson,
        namespace: "patched",
      });

      yield* executor.graphql.updateSource("patched", TEST_SCOPE, {
        endpoint: "http://localhost:5000/graphql",
        headers: { "x-custom": "abc" },
      });

      const source = yield* executor.graphql.getSource("patched", TEST_SCOPE);
      expect(source?.endpoint).toBe("http://localhost:5000/graphql");
      expect(source?.headers).toEqual({ "x-custom": "abc" });

      // Tools still present (no re-register happened, but they were
      // already there from addSource and haven't been removed).
      const tools = yield* executor.tools.list();
      expect(
        tools.filter((t) => t.sourceId === "patched").length,
      ).toBe(2);
    }),
  );

  it.effect("static graphql.addSource delegates to extension", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      const result = yield* executor.tools.invoke("graphql.addSource", {
        endpoint: "http://localhost:4000/graphql",
        introspectionJson,
        namespace: "via_static",
      });
      expect(result).toEqual({ toolCount: 2, namespace: "via_static" });

      const tools = yield* executor.tools.list();
      expect(
        tools.filter((t) => t.sourceId === "via_static").length,
      ).toBe(2);
    }),
  );

  // -------------------------------------------------------------------------
  // Multi-scope shadowing — regression suite covering the bug class where
  // store reads/writes that don't pin scope_id collapse onto whichever row
  // the scoped adapter's `scope_id IN (stack)` filter sees first. Each
  // scenario is reproducible against the pre-fix store.
  // -------------------------------------------------------------------------

  const ORG_SCOPE = ScopeId.make("org-scope");
  const USER_SCOPE = ScopeId.make("user-scope");

  const stackedScopes = [
    new Scope({ id: USER_SCOPE, name: "user", createdAt: new Date() }),
    new Scope({ id: ORG_SCOPE, name: "org", createdAt: new Date() }),
  ] as const;

  it.effect("shadowed addSource does not wipe the outer-scope source", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [graphqlPlugin()] as const,
        }),
      );

      // Org-level base source
      yield* executor.graphql.addSource({
        endpoint: "http://org.example.com/graphql",
        scope: ORG_SCOPE as string,
        introspectionJson,
        namespace: "shared",
        name: "Org Source",
      });

      // Per-user shadow with the same namespace
      yield* executor.graphql.addSource({
        endpoint: "http://user.example.com/graphql",
        scope: USER_SCOPE as string,
        introspectionJson,
        namespace: "shared",
        name: "User Source",
      });

      const userView = yield* executor.graphql.getSource(
        "shared",
        USER_SCOPE as string,
      );
      const orgView = yield* executor.graphql.getSource(
        "shared",
        ORG_SCOPE as string,
      );

      // Both rows must coexist — innermost-wins reads come from the
      // executor; the store's scope-pinned getters return the exact row.
      expect(userView?.name).toBe("User Source");
      expect(userView?.scope).toBe(USER_SCOPE as string);
      expect(userView?.endpoint).toBe("http://user.example.com/graphql");
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.scope).toBe(ORG_SCOPE as string);
      expect(orgView?.endpoint).toBe("http://org.example.com/graphql");
    }),
  );

  it.effect("removeSource on user shadow leaves the org row intact", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [graphqlPlugin()] as const,
        }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://org.example.com/graphql",
        scope: ORG_SCOPE as string,
        introspectionJson,
        namespace: "shared",
        name: "Org Source",
      });
      yield* executor.graphql.addSource({
        endpoint: "http://user.example.com/graphql",
        scope: USER_SCOPE as string,
        introspectionJson,
        namespace: "shared",
        name: "User Source",
      });

      yield* executor.graphql.removeSource("shared", USER_SCOPE as string);

      const userView = yield* executor.graphql.getSource(
        "shared",
        USER_SCOPE as string,
      );
      const orgView = yield* executor.graphql.getSource(
        "shared",
        ORG_SCOPE as string,
      );

      expect(userView).toBeNull();
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.endpoint).toBe("http://org.example.com/graphql");
    }),
  );

  it.effect("updateSource on user shadow does not mutate the org row", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [graphqlPlugin()] as const,
        }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://org.example.com/graphql",
        scope: ORG_SCOPE as string,
        introspectionJson,
        namespace: "shared",
        name: "Org Source",
      });
      yield* executor.graphql.addSource({
        endpoint: "http://user.example.com/graphql",
        scope: USER_SCOPE as string,
        introspectionJson,
        namespace: "shared",
        name: "User Source",
      });

      yield* executor.graphql.updateSource("shared", USER_SCOPE as string, {
        name: "User Renamed",
        endpoint: "http://user-new.example.com/graphql",
      });

      const userView = yield* executor.graphql.getSource(
        "shared",
        USER_SCOPE as string,
      );
      const orgView = yield* executor.graphql.getSource(
        "shared",
        ORG_SCOPE as string,
      );

      expect(userView?.name).toBe("User Renamed");
      expect(userView?.endpoint).toBe("http://user-new.example.com/graphql");
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.endpoint).toBe("http://org.example.com/graphql");
    }),
  );
});
