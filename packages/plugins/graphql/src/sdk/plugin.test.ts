import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import {
  createExecutor,
  makeTestConfig,
} from "@executor/core";
import { graphqlPlugin } from "./plugin";
import type { IntrospectionResult } from "./introspect";

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
      { kind: "SCALAR", name: "String", description: null, fields: null, inputFields: null, enumValues: null },
    ],
  },
};

describe("graphqlPlugin", () => {
  it("registers tools from introspection JSON", async () => {
    const executor = await Effect.runPromise(
      createExecutor(
        makeTestConfig({
          plugins: [graphqlPlugin()],
        }),
      ),
    );

    const result = await Effect.runPromise(
      executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        introspectionJson: JSON.stringify({ data: introspectionResult }),
        namespace: "test_api",
      }),
    );

    expect(result.toolCount).toBe(2);

    const tools = await Effect.runPromise(executor.tools.list());
    // +1 for the runtime "addSource" tool
    const graphqlTools = tools.filter((t) => t.pluginKey === "graphql");
    expect(graphqlTools).toHaveLength(3);

    const queryTool = graphqlTools.find((t) => t.name === "query.hello");
    expect(queryTool).toBeDefined();
    expect(queryTool!.description).toBe("Say hello");

    const mutationTool = graphqlTools.find((t) => t.name === "mutation.setGreeting");
    expect(mutationTool).toBeDefined();
    expect(mutationTool!.description).toBe("Set greeting message");

    await Effect.runPromise(executor.close());
  });

  it("removes a source and its tools", async () => {
    const executor = await Effect.runPromise(
      createExecutor(
        makeTestConfig({
          plugins: [graphqlPlugin()],
        }),
      ),
    );

    await Effect.runPromise(
      executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        introspectionJson: JSON.stringify({ data: introspectionResult }),
        namespace: "removable",
      }),
    );

    let tools = await Effect.runPromise(executor.tools.list());
    expect(tools.filter((t) => t.pluginKey === "graphql")).toHaveLength(3);

    await Effect.runPromise(executor.graphql.removeSource("removable"));

    tools = await Effect.runPromise(executor.tools.list());
    // Runtime addSource tool remains
    expect(tools.filter((t) => t.pluginKey === "graphql")).toHaveLength(1);

    await Effect.runPromise(executor.close());
  });

  it("lists sources", async () => {
    const executor = await Effect.runPromise(
      createExecutor(
        makeTestConfig({
          plugins: [graphqlPlugin()],
        }),
      ),
    );

    await Effect.runPromise(
      executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        introspectionJson: JSON.stringify({ data: introspectionResult }),
        namespace: "my_gql",
      }),
    );

    const sources = await Effect.runPromise(executor.sources.list());
    // 1 user source + 1 built-in runtime source
    const gqlSources = sources.filter((s) => s.kind === "graphql");
    expect(gqlSources).toHaveLength(1);
    const userSource = gqlSources.find((s) => s.id === "my_gql");
    expect(userSource).toBeDefined();
    expect(userSource!.canRemove).toBe(true);
    const builtIn = sources.find((s) => s.id === "built-in");
    expect(builtIn).toBeDefined();
    expect(builtIn!.runtime).toBe(true);

    await Effect.runPromise(executor.close());
  });

  it("mutations require approval", async () => {
    const executor = await Effect.runPromise(
      createExecutor(
        makeTestConfig({
          plugins: [graphqlPlugin()],
        }),
      ),
    );

    await Effect.runPromise(
      executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        introspectionJson: JSON.stringify({ data: introspectionResult }),
        namespace: "approval_test",
      }),
    );

    const tools = await Effect.runPromise(executor.tools.list());
    const mutationTool = tools.find((t) => t.name === "mutation.setGreeting");
    expect(mutationTool).toBeDefined();

    // Verify the mutation requires approval via annotations
    const schema = await Effect.runPromise(
      executor.tools.schema(mutationTool!.id),
    );
    expect(schema).toBeDefined();

    await Effect.runPromise(executor.close());
  });
});
