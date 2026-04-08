import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ParsedDocument } from "./parse";
import { parse } from "./parse";
import { extract } from "./extract";
import { previewSpec } from "./preview";
import type { ExtractionResult } from "./types";
import { createExecutor, makeTestConfig } from "@executor/core";
import { openApiPlugin } from "./plugin";

// ---------------------------------------------------------------------------
// Load + parse once, share across tests
// ---------------------------------------------------------------------------

const specPath = resolve(__dirname, "../../fixtures/cloudflare.json");
const specText = readFileSync(specPath, "utf-8");

let cachedDoc: ParsedDocument | null = null;
let cachedResult: ExtractionResult | null = null;

const getDoc = () =>
  Effect.gen(function* () {
    if (!cachedDoc) cachedDoc = yield* parse(specText);
    return cachedDoc;
  });

const getResult = () =>
  Effect.gen(function* () {
    if (!cachedResult) {
      const doc = yield* getDoc();
      cachedResult = yield* extract(doc);
    }
    return cachedResult;
  });

describe("Real specs: Cloudflare API", () => {
  it.effect("parses the full Cloudflare spec", () =>
    Effect.gen(function* () {
      const doc = yield* getDoc();
      expect(doc).toBeDefined();
    }),
  );

  it.effect("extracts operations from the Cloudflare spec", () =>
    Effect.gen(function* () {
      const result = yield* getResult();

      expect(Option.getOrElse(result.title, () => "")).toBe("Cloudflare API");
      expect(Option.getOrElse(result.version, () => "")).toBe("4.0.0");
      expect(result.operations.length).toBeGreaterThan(1000);

      for (const op of result.operations) {
        expect(op.operationId).toBeTruthy();
      }

      const validMethods = new Set([
        "get", "post", "put", "delete", "patch", "head", "options", "trace",
      ]);
      for (const op of result.operations) {
        expect(validMethods.has(op.method)).toBe(true);
      }

      const zoneOps = result.operations.filter((op) =>
        op.pathTemplate.includes("/zones"),
      );
      expect(zoneOps.length).toBeGreaterThan(0);

      const dnsOps = result.operations.filter((op) =>
        op.pathTemplate.includes("/dns_records"),
      );
      expect(dnsOps.length).toBeGreaterThan(0);
    }),
  );

  it.effect("operations have input schemas", () =>
    Effect.gen(function* () {
      const result = yield* getResult();

      const opsWithInput = result.operations.filter((op) =>
        Option.isSome(op.inputSchema),
      );
      expect(opsWithInput.length).toBeGreaterThan(500);
    }),
  );

  it.effect("operations have output schemas", () =>
    Effect.gen(function* () {
      const result = yield* getResult();

      const getOps = result.operations.filter((op) => op.method === "get");
      const getOpsWithOutput = getOps.filter((op) =>
        Option.isSome(op.outputSchema),
      );
      expect(getOpsWithOutput.length).toBeGreaterThan(getOps.length / 2);
    }),
  );

  it.effect("registers all operations as tools via the plugin", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [openApiPlugin()] as const,
        }),
      );

      const result = yield* executor.openapi.addSpec({
        spec: specText,
        namespace: "cloudflare",
      });

      expect(result.toolCount).toBeGreaterThan(1000);

      const tools = yield* executor.tools.list();
      expect(tools.length).toBe(result.toolCount + 2);

      const cloudflareTools = tools.filter((tool) => tool.sourceId === "cloudflare");
      expect(cloudflareTools.length).toBe(result.toolCount);

      for (const tool of cloudflareTools) {
        expect(tool.pluginKey).toBe("openapi");
        expect(tool.sourceId).toBe("cloudflare");
      }

      const zoneTools = yield* executor.tools.list({ query: "zone" });
      expect(zoneTools.length).toBeGreaterThan(0);
    }),
  );

  it.effect(
    "schema deduplication: definitions stored once, tools reference via $ref",
    () =>
      Effect.gen(function* () {
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [openApiPlugin()] as const }),
        );

        yield* executor.openapi.addSpec({
          spec: specText,
          namespace: "cloudflare",
        });

        const definitions = yield* executor.tools.definitions();
        expect(Object.keys(definitions).length).toBeGreaterThan(5000);
        expect(definitions["dns-records_dns_response_single"]).toBeDefined();

        const tools = yield* executor.tools.list({ query: "dns" });
        expect(tools.length).toBeGreaterThan(0);

        const schema = yield* executor.tools.schema(tools[0]!.id);

        // outputTypeScript should reference a named type from definitions
        expect(schema.outputTypeScript).toBeDefined();
        expect(schema.outputTypeScript!.length).toBeGreaterThan(0);

        // typeScriptDefinitions should carry the relevant subset
        expect(schema.typeScriptDefinitions).toBeDefined();
        const defs = schema.typeScriptDefinitions!;
        expect(Object.keys(defs).length).toBeGreaterThan(0);
        expect(Object.keys(defs).length).toBeLessThan(100);
      }),
  );

  it.effect("previewSpec returns security schemes and header presets", () =>
    Effect.gen(function* () {
      const preview = yield* previewSpec(specText);

      expect(preview.operationCount).toBeGreaterThan(1000);
      expect(Option.isSome(preview.title)).toBe(true);
      expect(preview.servers.length).toBeGreaterThan(0);

      // Cloudflare has 4 security schemes
      expect(preview.securitySchemes.length).toBe(4);
      const schemeNames = preview.securitySchemes.map((s) => s.name);
      expect(schemeNames).toContain("api_token");
      expect(schemeNames).toContain("api_key");
      expect(schemeNames).toContain("api_email");

      // Should have header presets derived from security strategies
      expect(preview.headerPresets.length).toBeGreaterThan(0);

      // Bearer token preset should include Authorization header
      const bearerPreset = preview.headerPresets.find((p) =>
        p.label.includes("Bearer"),
      );
      expect(bearerPreset).toBeDefined();
      expect(bearerPreset!.headers["Authorization"]).toBeNull(); // user must provide
      expect(bearerPreset!.secretHeaders).toContain("Authorization");

      // API key + email preset
      const keyEmailPreset = preview.headerPresets.find((p) =>
        p.label.includes("api_email"),
      );
      expect(keyEmailPreset).toBeDefined();
      expect(keyEmailPreset!.headers["X-Auth-Email"]).toBeNull();
      expect(keyEmailPreset!.headers["X-Auth-Key"]).toBeNull();
    }),
  );

  it.effect("removeSpec cleans up all Cloudflare tools", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [openApiPlugin()] as const,
        }),
      );

      yield* executor.openapi.addSpec({
        spec: specText,
        namespace: "cloudflare",
      });

      expect((yield* executor.tools.list()).length).toBeGreaterThan(0);

      yield* executor.openapi.removeSpec("cloudflare");

      const remaining = yield* executor.tools.list();
      expect(remaining.map((tool) => tool.id)).toEqual([
        "openapi.previewSpec",
        "openapi.addSource",
      ]);
    }),
  );
});
