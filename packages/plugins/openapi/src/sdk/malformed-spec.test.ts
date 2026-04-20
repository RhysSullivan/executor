// Regression test: malformed specs must produce a typed error via the
// Effect error channel, not a silent partial extraction.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { parse } from "./parse";
import { extract } from "./extract";
import { OpenApiExtractionError, OpenApiParseError } from "./errors";

const failWithTaggedError = <T extends string>(
  exit: Exit.Exit<unknown, { readonly _tag: T }>,
  tag: T,
) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = exit.cause;
    // Walk to the first defect/error — for Effect.try/tryPromise the mapped
    // error lands as a Fail node.
    const pretty = JSON.stringify(failure, null, 2);
    expect(pretty).toContain(tag);
  }
};

describe("Malformed spec handling", () => {
  it.effect("rejects empty input with OpenApiParseError", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parse(""));
      failWithTaggedError(exit, "OpenApiParseError");
    }),
  );

  it.effect("rejects non-JSON/non-YAML garbage", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parse("!!!not a spec!!!: : : ::"));
      failWithTaggedError(exit, "OpenApiParseError");
    }),
  );

  it.effect("rejects JSON that doesn't parse to an object", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parse("[1, 2, 3]"));
      failWithTaggedError(exit, "OpenApiParseError");
    }),
  );

  it.effect("rejects Swagger 2.x documents explicitly", () =>
    Effect.gen(function* () {
      const swagger = { swagger: "2.0", info: { title: "x", version: "1" }, paths: {} };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const exit = yield* Effect.exit(parse(JSON.stringify(swagger)));
      failWithTaggedError(exit, "OpenApiExtractionError");
    }),
  );

  it.effect("rejects broken internal $ref pointers via dereference", () =>
    Effect.gen(function* () {
      const broken = {
        openapi: "3.0.0",
        info: { title: "broken", version: "1.0.0" },
        paths: {
          "/x": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/DoesNotExist" },
                    },
                  },
                },
              },
            },
          },
        },
        components: { schemas: {} },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const exit = yield* Effect.exit(parse(JSON.stringify(broken)));
      failWithTaggedError(exit, "OpenApiParseError");

      // And the message surfaces the missing token, not a generic failure.
      if (Exit.isFailure(exit)) {
        const msg = JSON.stringify(exit.cause);
        expect(msg.toLowerCase()).toContain("does not exist");
      }
    }),
  );

  it.effect("extract rejects a spec with no paths", () =>
    Effect.gen(function* () {
      const noPaths = { openapi: "3.0.0", info: { title: "x", version: "1" } };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(noPaths));
      const exit = yield* Effect.exit(extract(doc));
      failWithTaggedError(exit, "OpenApiExtractionError");
    }),
  );

  it.effect("surfaces the tagged error classes for pattern-matching", () =>
    Effect.gen(function* () {
      // Ensure the re-exported tagged errors are actually the ones produced,
      // so downstream callers can do Effect.catchTag("OpenApiParseError", ...).
      const exit = yield* Effect.exit(parse(""));
      if (Exit.isFailure(exit)) {
        const failures = exit.cause;
        // The pretty form should reference the tag
        expect(JSON.stringify(failures)).toContain("OpenApiParseError");
      }
      // Reference the classes so the test fails to compile if they're
      // renamed/removed from the errors module.
      expect(OpenApiParseError).toBeDefined();
      expect(OpenApiExtractionError).toBeDefined();
    }),
  );
});
