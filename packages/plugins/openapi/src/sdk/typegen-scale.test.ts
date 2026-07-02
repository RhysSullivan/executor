// ---------------------------------------------------------------------------
// `executor generate` at catalog scale: 10,000 tools from one OpenAPI spec.
//
// The typed-proxy pipeline must hold up on instances with five-digit tool
// counts, end to end through the REAL ingestion path (addSpec compiles the
// spec, a connection persists the tool rows) rather than hand-built fixtures:
//   - `tools.export` returns every tool in one read,
//   - `generateToolProxySource` emits the file without blowing time or memory
//     (chunked schema compilation: one whole-catalog compiler pass is
//     super-linear and takes 30s+ at this size),
//   - the generated source is valid strict TypeScript, verified with the real
//     compiler, and spot-checked types resolve to the right shapes.
//
// Budgets are deliberately loose (CI machines vary) but tight enough to catch
// a regression to per-tool or whole-catalog compilation.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as ts from "typescript";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  createExecutor,
  generateToolProxySource,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { openApiPlugin } from "./plugin";

const TOOL_COUNT = 10_000;

// Build a 10k-operation spec with realistic shape variety: per-operation
// parameter schemas, shared component refs, and enough distinct field names
// that deduplication cannot collapse the work.
const buildScaleSpec = (toolCount: number): string => {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < toolCount; index += 1) {
    paths[`/resources${index % 100}/r${index}`] = {
      get: {
        operationId: `res.op${index}`,
        summary: `Operation ${index}`,
        parameters: [
          { name: "id", in: "query", required: true, schema: { type: "string" } },
          { name: `filter${index % 250}`, in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    item: { $ref: "#/components/schemas/Item" },
                    page: { $ref: "#/components/schemas/Page" },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    };
  }
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Scale", version: "1.0.0" },
    servers: [{ url: "https://scale.example.test" }],
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      schemas: {
        Item: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["id"],
        },
        Page: {
          type: "object",
          properties: { cursor: { type: "string" }, hasMore: { type: "boolean" } },
        },
      },
    },
  });
};

const typecheck = (source: string, extraSource: string): readonly string[] => {
  const fileName = "generated.ts";
  const fullSource = `${source}\n${extraSource}`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    candidate === fileName
      ? ts.createSourceFile(candidate, fullSource, languageVersion, true)
      : originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  host.readFile = (candidate) =>
    candidate === fileName ? fullSource : originalReadFile(candidate);
  host.fileExists = (candidate) => candidate === fileName || originalFileExists(candidate);

  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
};

describe("typed proxy generation at 10k-tool scale", () => {
  it.effect(
    "exports, generates, and typechecks a 10,000-tool catalog",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const executor = yield* createExecutor(
            makeTestConfig({
              plugins: [
                openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
                memoryCredentialsPlugin(),
              ] as const,
            }),
          );

          const added = yield* executor.openapi.addSpec({
            spec: { kind: "blob", value: buildScaleSpec(TOOL_COUNT) },
            slug: "scale",
          });
          expect(added.toolCount).toBe(TOOL_COUNT);

          yield* executor.connections.create({
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make("scale"),
            template: AuthTemplateSlug.make("apikey-0"),
            value: "token",
          });

          const exportStart = performance.now();
          const exported = yield* executor.tools.export({
            integration: IntegrationSlug.make("scale"),
          });
          const exportMs = performance.now() - exportStart;
          const exportedCount = exported.connections.reduce(
            (sum, connection) => sum + connection.tools.length,
            0,
          );
          expect(exportedCount).toBe(TOOL_COUNT);

          const generateStart = performance.now();
          const generated = generateToolProxySource(exported);
          const generateMs = performance.now() - generateStart;
          expect(generated.toolCount).toBe(TOOL_COUNT);

          // Regression tripwires, not benchmarks: whole-catalog single-pass
          // compilation measured 30s+ here and per-tool passes are far worse;
          // the chunked path runs in well under a second. 15s/30s absorb slow
          // CI machines while still failing on a complexity regression.
          expect(exportMs).toBeLessThan(15_000);
          expect(generateMs).toBeLessThan(30_000);

          // Every tool surfaced in the generated interface exactly once. The
          // plugin derives paths from the URL (`/resources77/r7777` →
          // `resources77.resOp7777`), so count the leaf entries.
          const opMatches = generated.source.match(/resOp\d+: ExecutorToolFn</g) ?? [];
          expect(opMatches.length).toBe(TOOL_COUNT);
          // Shared component schemas stay named refs, not 10k inlined copies.
          expect(generated.source).toContain("export type Item =");

          // The whole 10k-tool file typechecks under strict mode, and a
          // consumer gets real types out of an arbitrary tool in the middle.
          const diagnostics = typecheck(
            generated.source,
            `
              const client = createExecutorClient();
              async function main() {
                const outcome = await client.scale.org.main.resources77.resOp7777({ id: "x" });
                if (outcome.ok) {
                  const total: number | undefined = outcome.data.total;
                  const itemId: string | undefined = outcome.data.item?.id;
                  void total;
                  void itemId;
                }
              }
              void main;
            `,
          );
          expect(diagnostics).toEqual([]);
        }),
      ),
    { timeout: 180_000 },
  );
});
