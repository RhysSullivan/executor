// ---------------------------------------------------------------------------
// Compliance matrix — real-world spec extraction smoke tests.
//
// Each fixture lives under packages/plugins/openapi/fixtures/. The goal
// here is NOT deep invocation — it is "does parse + extract survive
// this real spec and produce a non-trivial operation list". Regressions
// in parsing / extraction (ref cycles, unusual content-types, exotic
// schemas) will surface as spec-specific failures.
//
// Additional in-depth assertions live on a per-spec basis — e.g. the
// NYT spec carries apiKey-in-query security which the preview path must
// detect.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { FetchHttpClient } from "@effect/platform";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "./parse";
import { extract } from "./extract";
import { previewSpec as previewSpecRaw } from "./preview";

const previewSpec = (input: string) =>
  previewSpecRaw(input).pipe(Effect.provide(FetchHttpClient.layer));

const loadFixture = (name: string): string =>
  readFileSync(resolve(__dirname, "../../fixtures", name), "utf-8");

// ---------------------------------------------------------------------------
// Petstore — the canonical example. Small, well-formed, covers GET/POST/
// PUT/DELETE, path + query + body. Anything even remotely broken here
// indicates a basic extraction regression.
// ---------------------------------------------------------------------------

describe("real-world fixture: Petstore", () => {
  const text = loadFixture("petstore.json");

  it.effect("parse + extract produces multiple operations", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(text);
      const result = yield* extract(doc);

      expect(result.operations.length).toBeGreaterThan(5);

      const methods = new Set(result.operations.map((op) => op.method));
      expect(methods.has("get")).toBe(true);
      expect(methods.has("post")).toBe(true);
    }),
  );

  it.effect("extracts the classic /pet/{petId} GET", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(text);
      const result = yield* extract(doc);

      const getPet = result.operations.find(
        (op) => op.method === "get" && op.pathTemplate === "/pet/{petId}",
      );
      expect(getPet).toBeDefined();

      const petIdParam = getPet!.parameters.find((p) => p.name === "petId");
      expect(petIdParam).toBeDefined();
      expect(petIdParam!.location).toBe("path");
      expect(petIdParam!.required).toBe(true);
    }),
  );

  it.effect("extracts a POST with a JSON request body", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(text);
      const result = yield* extract(doc);

      const post = result.operations.find(
        (op) => op.method === "post" && Option.isSome(op.requestBody),
      );
      expect(post).toBeDefined();
      const rb = Option.getOrThrow(post!.requestBody);
      expect(rb.contentType).toMatch(/json/);
    }),
  );
});

// ---------------------------------------------------------------------------
// Stripe — large, well-formed, tests perf + unusual schema shapes. Just
// prove we don't explode and that operation counts stay sane.
// ---------------------------------------------------------------------------

describe("real-world fixture: Stripe", { timeout: 60_000 }, () => {
  const text = loadFixture("stripe.json");

  it.effect("parses the Stripe spec end-to-end", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(text);
      const result = yield* extract(doc);

      // Stripe's spec has hundreds of operations. If this drops below
      // 200 something catastrophic happened in extraction.
      expect(result.operations.length).toBeGreaterThan(200);

      const methods = new Set(result.operations.map((op) => op.method));
      expect(methods.has("get")).toBe(true);
      expect(methods.has("post")).toBe(true);
    }),
  );

  it.effect("every Stripe operation has a non-empty operationId", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(text);
      const result = yield* extract(doc);
      for (const op of result.operations) {
        expect(op.operationId.length).toBeGreaterThan(0);
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// GitHub v3 REST — very large spec, heavy use of $ref + deep nesting.
// ---------------------------------------------------------------------------

describe("real-world fixture: GitHub REST v3", { timeout: 60_000 }, () => {
  const text = loadFixture("github.json");

  it.effect("parses the GitHub spec and extracts operations", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(text);
      const result = yield* extract(doc);

      expect(result.operations.length).toBeGreaterThan(500);

      // A well-known endpoint to sanity-check dereferencing.
      const reposGet = result.operations.find(
        (op) =>
          op.method === "get" && op.pathTemplate === "/repos/{owner}/{repo}",
      );
      expect(reposGet).toBeDefined();
    }),
  );
});

// ---------------------------------------------------------------------------
// NYT Article Search — small spec that carries `apiKey` in query.
// ---------------------------------------------------------------------------

describe("real-world fixture: NYT Article Search (apiKey-in-query)", () => {
  const text = loadFixture("nyt-article-search.json");

  it.effect("previewSpec surfaces the apiKey-in-query security scheme", () =>
    Effect.gen(function* () {
      const preview = yield* previewSpec(text);

      expect(preview.operationCount).toBeGreaterThan(0);
      const scheme = preview.securitySchemes.find((s) => s.type === "apiKey");
      expect(scheme).toBeDefined();
      expect(Option.getOrElse(scheme!.in, () => "")).toBe("query");
      // The preview surfaces the apiKey's in-header/query/cookie name via
      // `headerName` for display.
      expect(Option.getOrElse(scheme!.headerName, () => "")).toBe("api-key");
    }),
  );
});

// ---------------------------------------------------------------------------
// Cookie-auth fixture — this file is hand-authored to exercise the cookie
// security scheme extraction path, since real-world cookie-auth OpenAPI
// specs are rare.
// ---------------------------------------------------------------------------

describe("real-world fixture: cookie-auth", () => {
  const text = loadFixture("cookie-auth.json");

  it.effect("extracts a spec with cookie auth declared", () =>
    Effect.gen(function* () {
      const preview = yield* previewSpec(text);
      const scheme = preview.securitySchemes.find((s) => s.type === "apiKey");
      expect(scheme).toBeDefined();
      expect(Option.getOrElse(scheme!.in, () => "")).toBe("cookie");
      expect(Option.getOrElse(scheme!.headerName, () => "")).toBe("SESSIONID");
    }),
  );
});
