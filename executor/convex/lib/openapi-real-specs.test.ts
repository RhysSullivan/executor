/**
 * Integration tests against real-world OpenAPI specs.
 *
 * These verify the full pipeline: fetch → parse → generate types → compact → cache round-trip.
 * Catches regressions where a spec format change or library update breaks loading.
 *
 * Specs are fetched live so these tests require network access and are slower (~5-60s each).
 */
import { test, expect, describe } from "bun:test";
import { prepareOpenApiSpec, buildOpenApiToolsFromPrepared } from "./tool_sources";

interface SpecFixture {
  name: string;
  url: string;
  /** Minimum expected path count — sanity check the spec loaded fully */
  minPaths: number;
  /** Whether openapiTS should succeed (false for Swagger 2.x specs) */
  expectDts: boolean;
}

const SPECS: SpecFixture[] = [
  {
    name: "jira",
    url: "https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json",
    minPaths: 100,
    expectDts: true,
  },
  {
    name: "openai",
    url: "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml",
    minPaths: 10,
    expectDts: true,
  },
  {
    name: "github",
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml",
    minPaths: 500,
    expectDts: true,
  },
  {
    name: "vercel",
    url: "https://openapi.vercel.sh",
    minPaths: 50,
    expectDts: true,
  },
  {
    name: "slack",
    url: "https://api.slack.com/specs/openapi/v2/slack_web.json",
    minPaths: 50,
    // Swagger 2.x — openapiTS only supports OpenAPI 3.x, and no `servers` field
    expectDts: false,
  },
  {
    name: "stripe",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    minPaths: 100,
    expectDts: true,
  },
  {
    name: "cloudflare",
    url: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml",
    minPaths: 500,
    // Cloudflare has broken discriminator $ref mappings but generateOpenApiDts
    // now auto-patches them, so DTS generation succeeds.
    expectDts: true,
  },
  {
    name: "sentry",
    url: "https://raw.githubusercontent.com/getsentry/sentry-api-schema/refs/heads/main/openapi-derefed.json",
    minPaths: 50,
    expectDts: true,
  },
];

describe("real-world OpenAPI specs", () => {
  for (const fixture of SPECS) {
    test(
      `${fixture.name}: full pipeline`,
      async () => {
        const start = performance.now();
        const prepared = await prepareOpenApiSpec(fixture.url, fixture.name);
        const prepareMs = performance.now() - start;

        const pathCount = Object.keys(prepared.paths).length;
        const dtsSize = prepared.dts ? `${(prepared.dts.length / 1024).toFixed(0)}KB` : "none";

        console.log(
          `  ${fixture.name}: ${pathCount} paths, dts=${dtsSize}, prepare=${prepareMs.toFixed(0)}ms`,
        );

        // Spec loaded with enough paths
        expect(pathCount).toBeGreaterThanOrEqual(fixture.minPaths);

        // .d.ts generated (or correctly skipped for Swagger 2.x)
        if (fixture.expectDts) {
          expect(prepared.dts).toBeDefined();
          expect(prepared.dts!.length).toBeGreaterThan(0);
          // Should contain the operations interface
          expect(prepared.dts).toContain("operations");
        }

        // Servers extracted (Swagger 2.x specs may not have servers)
        if (fixture.expectDts) {
          expect(prepared.servers.length).toBeGreaterThan(0);
        }

        // Cache round-trip: serialize → deserialize → build tools
        const json = JSON.stringify(prepared);
        const restored = JSON.parse(json) as typeof prepared;
        expect(Object.keys(restored.paths).length).toBe(pathCount);

        // Build tools from the restored spec
        const buildStart = performance.now();
        const tools = buildOpenApiToolsFromPrepared(
          {
            type: "openapi",
            name: fixture.name,
            spec: fixture.url,
            baseUrl: prepared.servers[0] || `https://${fixture.name}.example.com`,
          },
          restored,
        );
        const buildMs = performance.now() - buildStart;

        console.log(
          `  ${fixture.name}: ${tools.length} tools, build=${buildMs.toFixed(0)}ms`,
        );

        expect(tools.length).toBeGreaterThan(0);

        // Spot-check: every tool has a path and type metadata
        for (const tool of tools) {
          expect(tool.path).toContain(`${fixture.name}.`);
          expect(typeof tool.description).toBe("string");
          expect(tool.metadata).toBeDefined();
          expect(tool.metadata!.argsType).toBeDefined();
          expect(tool.metadata!.returnsType).toBeDefined();
        }

        // If we have .d.ts, tools should carry operationId + sourceDts for typechecking
        if (fixture.expectDts) {
          // At least some tools should have operationId set
          const withOperationId = tools.filter(
            (t) => t.metadata!.operationId != null,
          );
          expect(withOperationId.length).toBeGreaterThan(0);

          // At least one tool per source should carry the raw .d.ts
          const withSourceDts = tools.filter(
            (t) => t.metadata!.sourceDts != null && t.metadata!.sourceDts!.length > 0,
          );
          expect(withSourceDts.length).toBeGreaterThan(0);

          // The sourceDts should contain operations interface
          const dts = withSourceDts[0].metadata!.sourceDts!;
          expect(dts).toContain("operations");
        }

        if (prepared.warnings.length > 0) {
          console.log(`  ${fixture.name} warnings: ${prepared.warnings.join("; ")}`);
        }
      },
      // These fetch real specs over the network — generous timeout
      300_000,
    );
  }
});
