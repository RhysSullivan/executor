import { readFileSync } from "node:fs";

import {
  describe,
  expect,
  it,
} from "vitest";
import * as Effect from "effect/Effect";

import {
  buildLoadedSourceCatalogToolContract,
} from "../../../packages/platform/sdk/src/runtime/catalog/source/runtime";
import {
  buildOpenApiTestHarness,
} from "./test-harness";

const smokeFixtures = [
  {
    name: "Vercel API",
    fixture: "../../../packages/platform/sdk/src/runtime/fixtures/vercel-openapi.json",
    documentKey: "https://example.com/vercel-openapi.json",
  },
  {
    name: "Neon API",
    fixture: "../../../packages/platform/sdk/src/runtime/fixtures/neon-openapi.json",
    documentKey: "https://example.com/neon-openapi.json",
  },
  {
    name: "Slack Web API",
    fixture: "./fixtures/slack-openapi.json",
    documentKey:
      "https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2_without_examples.json",
  },
  {
    name: "Resend API",
    fixture: "./fixtures/resend-openapi.yaml",
    documentKey:
      "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml",
  },
] as const;

describe("openapi smoke imports", () => {
  for (const fixture of smokeFixtures) {
    it(`imports ${fixture.name} end-to-end`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const contentText = readFileSync(
            new URL(fixture.fixture, import.meta.url),
            "utf8",
        );
        const result = yield* buildOpenApiTestHarness({
          name: fixture.name,
          contentText,
          documentKey: fixture.documentKey,
          extraction: {
            documentUrl: fixture.documentKey,
          },
        });

        expect(result.manifest.tools.length).toBeGreaterThan(0);
        expect(result.operations.length).toBe(result.manifest.tools.length);
        expect(result.tools.length).toBe(result.manifest.tools.length);

        const unresolvedRefs = Object.values(result.snapshot.catalog.diagnostics).filter(
          (diagnostic) => diagnostic.code === "unresolved_ref",
        );
        expect(unresolvedRefs).toHaveLength(0);

          for (const tool of result.tools) {
            const contract = yield* buildLoadedSourceCatalogToolContract(tool);
            expect(contract.callDeclaration.length).toBeGreaterThan(0);
            expect((contract.input.typeDeclaration ?? "").length).toBeGreaterThan(0);
            expect((contract.output.typeDeclaration ?? "").length).toBeGreaterThan(0);
          }
        }),
      );
    }, 20_000);
  }

  it("resolves external relative refs through the extraction loader", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const rootUrl = new URL("./fixtures/openapi-external/root.yaml", import.meta.url);
        const contentText = readFileSync(rootUrl, "utf8");
        const result = yield* buildOpenApiTestHarness({
        name: "External Ref API",
        contentText,
        documentKey: rootUrl.toString(),
        extraction: {
          documentUrl: rootUrl.toString(),
          loadDocument: async (url) => readFileSync(new URL(url), "utf8"),
        },
      });

      expect(result.manifest.tools).toHaveLength(1);
      expect(result.tools).toHaveLength(1);

      const contract = yield* buildLoadedSourceCatalogToolContract(result.tools[0]!);
        expect(contract.input.typeDeclaration).toContain("widgetId: string;");
        expect(contract.output.typeDeclaration).toContain("type ExternalRefApiWidgetsGetResult");
        expect(contract.output.typeDeclaration).toContain("name: string;");
        expect(contract.output.typeDeclaration).toContain("tags?: Array<string>;");
      }),
    );
  }, 10_000);
});
