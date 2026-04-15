// ---------------------------------------------------------------------------
// End-to-end tests for the plugin SDK.
//
// Runs against `@executor/storage-memory` — no disk, no SQL parser, no
// migrations. Every test exercises the core data model + plugin surface
// against fresh storage. Uses `@effect/vitest`'s `it.effect` so each
// test body is a plain `Effect.gen` block and failures surface through
// Effect's error channel rather than unhandled promise rejections.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Cause, Data, Effect, Exit } from "effect";

import { makeInMemoryAdapter } from "@executor/storage-memory";

import { makeInMemoryBlobStore } from "../blob";
import {
  SourceRemovalNotAllowedError,
  ToolInvocationError,
  ToolNotFoundError,
} from "../errors";
import { createExecutor } from "../executor";
import { keychainPlugin } from "../__fixtures__/keychain";
import {
  openapiPlugin,
  type OpenApiOperation,
  type OpenApiSpecStore,
  type StoredSpec,
} from "../__fixtures__/openapi";
import { graphqlPlugin } from "../__fixtures__/graphql";

class SimulatedFailure extends Data.TaggedError("SimulatedFailure")<{
  readonly message: string;
}> {}

const scope = {
  id: "test-scope",
  name: "Test Scope",
  createdAt: new Date(),
};

const buildPlugins = () =>
  [keychainPlugin(), openapiPlugin(), graphqlPlugin()] as const;

/** Fresh in-memory adapter + blob store. One per test. */
const buildCtx = () => ({
  adapter: makeInMemoryAdapter(),
  blobs: makeInMemoryBlobStore(),
});

describe("sdk-greenfield end-to-end (core data model)", () => {
  it.effect("createExecutor + add sources + invoke tools", () =>
    Effect.gen(function* () {
      const { adapter, blobs } = buildCtx();
      const plugins = buildPlugins();
      const executor = yield* createExecutor({
        scope,
        adapter,
        blobs,
        plugins,
      });

      // After createExecutor, the core `source` table should contain
      // the two static control sources (openapi.control, graphql.control).
      // keychain contributes none.
      const initialSources = yield* executor.sources.list();
      expect(initialSources.map((s) => s.id).sort()).toEqual([
        "graphql.control",
        "openapi.control",
      ]);

      // Core `tool` table has three rows: two from openapi.control,
      // one from graphql.control.
      const initialTools = yield* executor.tools.list();
      expect(initialTools.map((t) => t.id).sort()).toEqual([
        "graphql.control.add-endpoint",
        "openapi.control.add-source",
        "openapi.control.preview-spec",
      ]);

      // Every tool has `sourceId` set correctly — that's the core
      // data model enforcing "tools belong to sources."
      for (const tool of initialTools) {
        expect(initialSources.some((s) => s.id === tool.sourceId)).toBe(true);
      }

      // Add an OpenAPI spec via the extension API. This should write
      // plugin enrichment (openapi_operation rows + spec blob) AND
      // core metadata (source + tool rows) in one transaction.
      const added = yield* executor.openapi.addSpec({
        namespace: "petstore",
        name: "Petstore",
        baseUrl: "https://petstore.example.com",
        spec: '{ "openapi": "3.0.0" }',
        operations: [
          { toolName: "listPets", method: "GET", path: "/pets" },
          { toolName: "getPet", method: "GET", path: "/pets/{id}" },
        ],
      });
      expect(added).toEqual({ sourceId: "petstore", toolCount: 2 });

      // Add a GraphQL endpoint — core-only, no plugin enrichment.
      yield* executor.graphql.addEndpoint({
        id: "github",
        name: "GitHub GraphQL",
        endpoint: "https://api.github.com/graphql",
      });

      // Keychain secret round-trip.
      yield* executor.secrets.set("petstore.apikey", "sk-123", "keychain");
      expect(yield* executor.secrets.get("petstore.apikey")).toBe("sk-123");

      // Sources list has both control sources + petstore + github.
      const allSources = yield* executor.sources.list();
      expect(allSources.map((s) => s.id).sort()).toEqual([
        "github",
        "graphql.control",
        "openapi.control",
        "petstore",
      ]);

      // Tools list has all six.
      const allTools = yield* executor.tools.list();
      expect(allTools.map((t) => t.id).sort()).toEqual([
        "github.query",
        "graphql.control.add-endpoint",
        "openapi.control.add-source",
        "openapi.control.preview-spec",
        "petstore.getPet",
        "petstore.listPets",
      ]);

      // Invoke a dynamic openapi tool — core findOne → delegate to
      // openapi.invokeTool → fetch binding from plugin storage →
      // return stub result.
      const result = (yield* executor.tools.invoke("petstore.listPets", {
        limit: 10,
      })) as {
        source: string;
        tool: string;
        method: string;
        path: string;
        args: { limit: number };
      };
      expect(result).toEqual({
        source: "petstore",
        tool: "listPets",
        method: "GET",
        path: "/pets",
        args: { limit: 10 },
      });

      // Invoke a static control tool — same core lookup, same delegation.
      const control = (yield* executor.tools.invoke(
        "openapi.control.preview-spec",
        { spec: "..." },
      )) as { previewed: boolean };
      expect(control.previewed).toBe(true);

      // Direct-query the core tables to verify split persistence.
      const sourceRows = yield* adapter.findMany<Record<string, unknown>>({
        model: "source",
        where: [{ field: "id", value: "petstore" }],
      });
      expect(sourceRows).toHaveLength(1);
      expect(sourceRows[0]).toMatchObject({
        id: "petstore",
        plugin_id: "openapi",
        kind: "openapi",
        name: "Petstore",
      });
      // Audit columns populate on write.
      expect(sourceRows[0]!.created_at).toBeTruthy();
      expect(sourceRows[0]!.updated_at).toBeTruthy();

      const operationRows = yield* adapter.findMany<Record<string, unknown>>({
        model: "openapi_operation",
        where: [{ field: "source_id", value: "petstore" }],
      });
      expect(operationRows).toHaveLength(2);

      const toolRows = yield* adapter.findMany<Record<string, unknown>>({
        model: "tool",
        where: [{ field: "source_id", value: "petstore" }],
      });
      expect(toolRows).toHaveLength(2);
      for (const row of toolRows) {
        expect(row.created_at).toBeTruthy();
        expect(row.updated_at).toBeTruthy();
      }

      // Plugin-specific details via the extension API — the
      // "call the plugin for details" pattern. Core doesn't know
      // openapi's method/path; only the plugin does.
      const binding = yield* executor.openapi.getOperation(
        "petstore",
        "listPets",
      );
      expect(binding).toMatchObject({
        toolName: "listPets",
        method: "GET",
        path: "/pets",
      });

      // Raw spec blob is fetchable through the extension.
      const storedSpec = yield* executor.openapi.getSpec("petstore");
      expect(storedSpec?.spec).toContain("openapi");

      yield* executor.close();
    }),
  );

  it.effect("persistence across executor instances (no rehydration loop)", () =>
    Effect.gen(function* () {
      const { adapter, blobs } = buildCtx();
      const plugins = buildPlugins();

      // First executor: populate state.
      const first = yield* createExecutor({
        scope,
        adapter,
        blobs,
        plugins,
      });
      yield* first.openapi.addSpec({
        namespace: "petstore",
        name: "Petstore",
        spec: "{}",
        operations: [{ toolName: "listPets", method: "GET", path: "/pets" }],
      });
      yield* first.graphql.addEndpoint({
        id: "github",
        name: "GitHub",
        endpoint: "https://api.github.com/graphql",
      });
      yield* first.close();

      // Second executor: the core tables already have petstore + github.
      // No plugin init reads them — the executor just starts up,
      // upserts its static control sources, and returns. When
      // `second.sources.list()` is called, it's a core query that
      // returns everything.
      const second = yield* createExecutor({
        scope,
        adapter,
        blobs,
        plugins,
      });
      const sources = yield* second.sources.list();
      const ids = sources.map((s) => s.id).sort();
      expect(ids).toEqual([
        "github",
        "graphql.control",
        "openapi.control",
        "petstore",
      ]);

      // The dynamic openapi tool is reachable — core lookup finds the
      // tool row, delegates to the plugin's invokeTool, which fetches
      // the operation binding from plugin storage.
      const result = (yield* second.tools.invoke("petstore.listPets", {
        limit: 5,
      })) as { source: string; tool: string };
      expect(result.source).toBe("petstore");
      expect(result.tool).toBe("listPets");

      yield* second.close();
    }),
  );

  // -----------------------------------------------------------------------
  // Pattern C: custom OpenApiSpecStore override. The override skips
  // plugin enrichment writes, but the core source/tool tables still
  // get populated via ctx.core.sources.register (a separate path).
  // -----------------------------------------------------------------------
  it.effect("Pattern C: custom OpenApiSpecStore skips plugin enrichment", () =>
    Effect.gen(function* () {
      const specs = new Map<string, StoredSpec>();
      const calls = {
        upsertSpec: 0,
        getSpec: 0,
        getOperation: 0,
        removeSpec: 0,
      };
      const trackingStore: OpenApiSpecStore = {
        upsertSpec: (input) =>
          Effect.sync(() => {
            calls.upsertSpec++;
            specs.set(input.namespace, {
              id: input.namespace,
              spec: input.spec,
              operations: input.operations,
            });
          }),
        getSpec: (id) =>
          Effect.sync(() => {
            calls.getSpec++;
            return specs.get(id) ?? null;
          }),
        getOperation: (sourceId, toolName) =>
          Effect.sync(() => {
            calls.getOperation++;
            const spec = specs.get(sourceId);
            if (!spec) return null;
            const op = spec.operations.find(
              (o: OpenApiOperation) => o.toolName === toolName,
            );
            return op ?? null;
          }),
        removeSpec: (id) =>
          Effect.sync(() => {
            calls.removeSpec++;
            specs.delete(id);
          }),
      };

      const { adapter, blobs } = buildCtx();
      const plugins = [
        keychainPlugin(),
        openapiPlugin({ storage: () => trackingStore }),
        graphqlPlugin(),
      ] as const;

      const executor = yield* createExecutor({
        scope,
        adapter,
        blobs,
        plugins,
      });

      yield* executor.openapi.addSpec({
        namespace: "petstore",
        name: "Petstore",
        baseUrl: "https://petstore.example.com",
        spec: '{ "openapi": "3.0.0" }',
        operations: [{ toolName: "listPets", method: "GET", path: "/pets" }],
      });

      // Plugin enrichment was tracked, not written to the adapter.
      expect(calls.upsertSpec).toBe(1);
      expect(specs.size).toBe(1);

      // Plugin-owned `openapi_operation` table is empty.
      const opRows = yield* adapter.findMany<Record<string, unknown>>({
        model: "openapi_operation",
      });
      expect(opRows).toHaveLength(0);

      // The blob store in the 'openapi' namespace is empty.
      const specBlob = yield* blobs.get("openapi", "source/petstore/spec");
      expect(specBlob).toBeNull();

      // But the CORE source + tool tables ARE populated — that write
      // went through ctx.core.sources.register, which the tracking
      // store never sees. Pattern C overrides plugin-specific storage
      // without bypassing the core data model.
      const sourceRows = yield* adapter.findMany<Record<string, unknown>>({
        model: "source",
        where: [{ field: "id", value: "petstore" }],
      });
      expect(sourceRows).toHaveLength(1);

      const toolRows = yield* adapter.findMany<Record<string, unknown>>({
        model: "tool",
        where: [{ field: "source_id", value: "petstore" }],
      });
      expect(toolRows).toHaveLength(1);

      // Tool invocation still works — core lookup finds the tool row,
      // delegates to openapi.invokeTool, which calls the tracking
      // store's getOperation to fetch the binding.
      const result = (yield* executor.tools.invoke("petstore.listPets", {
        limit: 3,
      })) as { source: string; tool: string; method: string };
      expect(result.source).toBe("petstore");
      expect(result.method).toBe("GET");
      expect(calls.getOperation).toBeGreaterThanOrEqual(1);

      yield* executor.close();
    }),
  );

  // -----------------------------------------------------------------------
  // Tagged errors at the executor surface. Consumers can pattern-match
  // on `_tag` instead of string-matching error messages.
  // -----------------------------------------------------------------------
  it.effect(
    "executor surfaces tagged errors (ToolNotFound, SourceRemovalNotAllowed, ToolInvocationError)",
    () =>
      Effect.gen(function* () {
        const { adapter, blobs } = buildCtx();
        const plugins = buildPlugins();
        const executor = yield* createExecutor({
          scope,
          adapter,
          blobs,
          plugins,
        });

        // 1. ToolNotFoundError
        const notFoundExit = yield* Effect.exit(
          executor.tools.invoke("nonexistent.tool", {}),
        );
        expect(Exit.isFailure(notFoundExit)).toBe(true);
        if (Exit.isFailure(notFoundExit)) {
          const error = Cause.failureOption(notFoundExit.cause);
          if (error._tag === "Some") {
            expect(error.value).toBeInstanceOf(ToolNotFoundError);
            expect((error.value as ToolNotFoundError).toolId).toBe(
              "nonexistent.tool",
            );
          }
        }

        // 2. SourceRemovalNotAllowedError — try to remove a static
        // control source (openapi.control has canRemove: false).
        const removalExit = yield* Effect.exit(
          executor.sources.remove("openapi.control"),
        );
        expect(Exit.isFailure(removalExit)).toBe(true);
        if (Exit.isFailure(removalExit)) {
          const error = Cause.failureOption(removalExit.cause);
          if (error._tag === "Some") {
            expect(error.value).toBeInstanceOf(SourceRemovalNotAllowedError);
            expect(
              (error.value as SourceRemovalNotAllowedError).sourceId,
            ).toBe("openapi.control");
          }
        }
        // Confirm the static source is still there after the rejected remove.
        const stillThere = yield* adapter.findOne<Record<string, unknown>>({
          model: "source",
          where: [{ field: "id", value: "openapi.control" }],
        });
        expect(stillThere).not.toBeNull();

        // 3. ToolInvocationError — handler raises, executor wraps.
        // Insert a bogus tool row for the graphql plugin so its
        // invokeTool fails on the "unknown dynamic tool" path.
        yield* executor.graphql.addEndpoint({
          id: "fake-gql",
          name: "Fake",
          endpoint: "https://fake.example.com",
        });
        const now = new Date();
        yield* adapter.create({
          model: "tool",
          data: {
            id: "fake-gql.bogus",
            source_id: "fake-gql",
            plugin_id: "graphql",
            name: "bogus",
            description: "not a real tool",
            input_schema: null,
            output_schema: null,
            created_at: now,
            updated_at: now,
          },
          forceAllowId: true,
        });
        const invokeExit = yield* Effect.exit(
          executor.tools.invoke("fake-gql.bogus", {}),
        );
        expect(Exit.isFailure(invokeExit)).toBe(true);
        if (Exit.isFailure(invokeExit)) {
          const error = Cause.failureOption(invokeExit.cause);
          if (error._tag === "Some") {
            expect(error.value).toBeInstanceOf(ToolInvocationError);
            expect((error.value as ToolInvocationError).toolId).toBe(
              "fake-gql.bogus",
            );
          }
        }

        yield* executor.close();
      }),
  );

  // -----------------------------------------------------------------------
  // Atomic transaction: if plugin storage fails mid-addSpec, both the
  // plugin enrichment AND the core source/tool writes roll back.
  // -----------------------------------------------------------------------
  it.effect(
    "atomic transaction: addSpec rolls back core + plugin writes on failure",
    () =>
      Effect.gen(function* () {
        const failingStore: OpenApiSpecStore = {
          upsertSpec: () =>
            new SimulatedFailure({
              message: "simulated plugin storage failure",
            }),
          getSpec: () => Effect.succeed(null),
          getOperation: () => Effect.succeed(null),
          removeSpec: () => Effect.void,
        };

        const { adapter, blobs } = buildCtx();
        const plugins = [
          keychainPlugin(),
          openapiPlugin({ storage: () => failingStore }),
          graphqlPlugin(),
        ] as const;
        const executor = yield* createExecutor({
          scope,
          adapter,
          blobs,
          plugins,
        });

        const exit = yield* Effect.exit(
          executor.openapi.addSpec({
            namespace: "petstore",
            name: "Petstore",
            spec: "{}",
            operations: [
              { toolName: "listPets", method: "GET", path: "/pets" },
            ],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);

        // Neither the core source row nor any tool rows should exist.
        const sourceRows = yield* adapter.findMany({
          model: "source",
          where: [{ field: "id", value: "petstore" }],
        });
        expect(sourceRows).toHaveLength(0);

        const toolRows = yield* adapter.findMany({
          model: "tool",
          where: [{ field: "source_id", value: "petstore" }],
        });
        expect(toolRows).toHaveLength(0);

        yield* executor.close();
      }),
  );

  // -----------------------------------------------------------------------
  // JSON schema columns round-trip. Storage-memory is a pass-through
  // (objects stay objects), so this exercises the decodeJsonColumn
  // pass-through branch in executor.ts's rowToTool.
  // -----------------------------------------------------------------------
  it.effect("JSON schema columns round-trip correctly", () =>
    Effect.gen(function* () {
      const { adapter, blobs } = buildCtx();
      const plugins = buildPlugins();
      const executor = yield* createExecutor({
        scope,
        adapter,
        blobs,
        plugins,
      });

      const now = new Date();
      yield* adapter.create({
        model: "source",
        data: {
          id: "schema-test",
          plugin_id: "openapi",
          kind: "openapi",
          name: "Schema Test",
          url: null,
          can_remove: true,
          can_refresh: false,
          created_at: now,
          updated_at: now,
        },
        forceAllowId: true,
      });
      yield* adapter.create({
        model: "tool",
        data: {
          id: "schema-test.query",
          source_id: "schema-test",
          plugin_id: "openapi",
          name: "query",
          description: "A test tool with a populated input schema",
          input_schema: {
            type: "object",
            properties: {
              limit: { type: "number" },
              filter: { type: "string" },
            },
          },
          output_schema: { type: "array", items: { type: "object" } },
          created_at: now,
          updated_at: now,
        },
        forceAllowId: true,
      });

      const tools = yield* executor.tools.list();
      const tool = tools.find((t) => t.id === "schema-test.query");
      expect(tool).toBeDefined();
      expect(tool?.inputSchema).toEqual({
        type: "object",
        properties: {
          limit: { type: "number" },
          filter: { type: "string" },
        },
      });
      expect(tool?.outputSchema).toEqual({
        type: "array",
        items: { type: "object" },
      });

      yield* executor.close();
    }),
  );
});
