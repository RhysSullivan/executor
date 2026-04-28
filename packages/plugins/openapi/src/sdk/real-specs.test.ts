// Parse / extract / preview coverage against a big real-world spec.
// DB-touching behaviour (addSpec, removeSpec, tool registration) moved
// to apps/cloud/src/services/sources-api.node.test.ts — those run
// through the real postgres + drizzle adapter so adapter regressions
// (e.g. a per-row createMany fallback) surface automatically instead
// of needing a dedicated budget assertion.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { FetchHttpClient } from "@effect/platform";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ParsedDocument } from "./parse";
import { parse } from "./parse";
import { extract } from "./extract";
import { previewSpec as previewSpecRaw } from "./preview";
import type { ExtractionResult } from "./types";

const previewSpec = (input: string) =>
  previewSpecRaw(input).pipe(Effect.provide(FetchHttpClient.layer));

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

describe("Real specs: Cloudflare API", { timeout: 60_000 }, () => {
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
        "get",
        "post",
        "put",
        "delete",
        "patch",
        "head",
        "options",
        "trace",
      ]);
      for (const op of result.operations) {
        expect(validMethods.has(op.method)).toBe(true);
      }

      const zoneOps = result.operations.filter((op) => op.pathTemplate.includes("/zones"));
      expect(zoneOps.length).toBeGreaterThan(0);

      const dnsOps = result.operations.filter((op) => op.pathTemplate.includes("/dns_records"));
      expect(dnsOps.length).toBeGreaterThan(0);
    }),
  );

  it.effect("operations have input schemas", () =>
    Effect.gen(function* () {
      const result = yield* getResult();

      const opsWithInput = result.operations.filter((op) => Option.isSome(op.inputSchema));
      expect(opsWithInput.length).toBeGreaterThan(500);
    }),
  );

  it.effect("operations have output schemas", () =>
    Effect.gen(function* () {
      const result = yield* getResult();

      const getOps = result.operations.filter((op) => op.method === "get");
      const getOpsWithOutput = getOps.filter((op) => Option.isSome(op.outputSchema));
      expect(getOpsWithOutput.length).toBeGreaterThan(getOps.length / 2);
    }),
  );

  it.effect("previewSpec returns security schemes and header presets", () =>
    Effect.gen(function* () {
      const preview = yield* previewSpec(specText);

      expect(preview.operationCount).toBeGreaterThan(1000);
      expect(Option.isSome(preview.title)).toBe(true);
      expect(preview.servers.length).toBeGreaterThan(0);

      expect(preview.securitySchemes.length).toBe(4);
      const schemeNames = preview.securitySchemes.map((s) => s.name);
      expect(schemeNames).toContain("api_token");
      expect(schemeNames).toContain("api_key");
      expect(schemeNames).toContain("api_email");

      expect(preview.headerPresets.length).toBeGreaterThan(0);

      const bearerPreset = preview.headerPresets.find((p) => p.label.includes("Bearer"));
      expect(bearerPreset).toBeDefined();
      expect(bearerPreset!.headers["Authorization"]).toBeNull();
      expect(bearerPreset!.secretHeaders).toContain("Authorization");

      const keyEmailPreset = preview.headerPresets.find((p) => p.label.includes("api_email"));
      expect(keyEmailPreset).toBeDefined();
      expect(keyEmailPreset!.headers["X-Auth-Email"]).toBeNull();
      expect(keyEmailPreset!.headers["X-Auth-Key"]).toBeNull();
    }),
  );
});
