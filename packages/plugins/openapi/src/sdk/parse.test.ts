import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { OpenApiParseError } from "./errors";
import {
  ensureGenericOpenApiSpecTextWithinLimit,
  MAX_GENERIC_OPENAPI_SPEC_TEXT_LENGTH,
  parse,
} from "./parse";

describe("OpenAPI parse", () => {
  it.effect("parses JSON OpenAPI documents", () =>
    Effect.gen(function* () {
      const doc = yield* parse(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Test", version: "1.0.0" },
          paths: {},
        }),
      );

      expect(doc.openapi).toBe("3.1.0");
    }),
  );

  it.effect("parses YAML OpenAPI documents", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`
openapi: 3.0.0
info:
  title: Test
  version: 1.0.0
paths: {}
`);

      expect(doc.openapi).toBe("3.0.0");
    }),
  );

  it.effect("falls back to YAML for flow-style YAML documents", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`
{
  openapi: 3.0.0,
  info: { title: Test, version: 1.0.0 },
  paths: {}
}
`);

      expect(doc.openapi).toBe("3.0.0");
    }),
  );

  it.effect("returns a stable parse error for empty documents", () =>
    Effect.gen(function* () {
      const error = yield* parse("").pipe(Effect.flip);

      expect(error).toBeInstanceOf(OpenApiParseError);
      expect(error).toHaveProperty("message", "OpenAPI document is empty");
    }),
  );

  it.effect("returns a stable parse error for non-object documents", () =>
    Effect.gen(function* () {
      const error = yield* parse("[]").pipe(Effect.flip);

      expect(error).toBeInstanceOf(OpenApiParseError);
      expect(error).toHaveProperty("message", "OpenAPI document must parse to an object");
    }),
  );

  it.effect("rejects oversized generic OpenAPI documents before parsing", () =>
    Effect.gen(function* () {
      const error = yield* ensureGenericOpenApiSpecTextWithinLimit(
        "x".repeat(MAX_GENERIC_OPENAPI_SPEC_TEXT_LENGTH + 1),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(OpenApiParseError);
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("too large for the generic OpenAPI importer"),
      );
    }),
  );
});
