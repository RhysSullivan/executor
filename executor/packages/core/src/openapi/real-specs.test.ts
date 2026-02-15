/**
 * Integration tests against real-world OpenAPI specs.
 *
 * These verify the full pipeline: fetch → parse → generate types → compact → cache round-trip.
 * Catches regressions where a spec format change or library update breaks loading.
 *
 * Specs are fetched live so these tests require network access and are slower (~5-60s each).
 */
import { test, expect, describe } from "bun:test";
import { prepareOpenApiSpec, buildOpenApiToolsFromPrepared } from "../tool-sources";

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

        // Spot-check: every tool has a path and schema-first typing
        for (const tool of tools) {
          expect(tool.path).toContain(`${fixture.name}.`);
          expect(typeof tool.description).toBe("string");
          expect(tool.typing).toBeDefined();
        }

        // If we have .d.ts, tools should carry typed refs for high-fidelity typing
        if (fixture.expectDts) {
          const withTypedRef = tools.filter(
            (t) => t.typing?.typedRef?.kind === "openapi_operation",
          );
          expect(withTypedRef.length).toBeGreaterThan(0);
        }

        if (prepared.warnings.length > 0) {
          console.log(`  ${fixture.name} warnings: ${prepared.warnings.join("; ")}`);
        }
      },
      // These fetch real specs over the network — generous timeout
      300_000,
    );
  }

  test(
    "github: delete repo subscription keeps typed args and void return",
    async () => {
      const githubUrl =
        "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml";

      const prepared = await prepareOpenApiSpec(githubUrl, "github");
      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "github",
          spec: githubUrl,
          baseUrl: prepared.servers[0] || "https://api.github.com",
        },
        prepared,
      );

      const tool = tools.find(
        (t) => t.typing?.typedRef?.kind === "openapi_operation" && t.typing.typedRef.operationId === "activity/delete-repo-subscription",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("github.activity.delete_repo_subscription");
      expect(tool!.typing?.requiredInputKeys ?? []).toContain("owner");
      expect(tool!.typing?.requiredInputKeys ?? []).toContain("repo");
    },
    300_000,
  );

  test(
    "github: add custom labels to repo runner keeps concrete compact arg hints",
    async () => {
      const githubUrl =
        "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml";

      const prepared = await prepareOpenApiSpec(githubUrl, "github", { includeDts: false });
      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "github",
          spec: githubUrl,
          baseUrl: prepared.servers[0] || "https://api.github.com",
        },
        prepared,
      );

      const tool = tools.find(
        (t) => t.typing?.typedRef?.kind === "openapi_operation" && t.typing.typedRef.operationId === "actions/add-custom-labels-to-self-hosted-runner-for-repo",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("github.actions.add_custom_labels_to_self_hosted_runner_for_repo");
      expect(tool!.typing?.requiredInputKeys ?? []).toContain("owner");
      expect(tool!.typing?.requiredInputKeys ?? []).toContain("repo");
      expect(tool!.typing?.requiredInputKeys ?? []).toContain("runner_id");
      expect(tool!.typing?.requiredInputKeys ?? []).toContain("labels");
    },
    300_000,
  );

  test(
    "github: create hosted runner for org has non-unknown return hint",
    async () => {
      const githubUrl =
        "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml";

      const prepared = await prepareOpenApiSpec(githubUrl, "github");
      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "github",
          spec: githubUrl,
          baseUrl: prepared.servers[0] || "https://api.github.com",
        },
        prepared,
      );

      const tool = tools.find(
        (t) => t.typing?.typedRef?.kind === "openapi_operation" && t.typing.typedRef.operationId === "actions/create-hosted-runner-for-org",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("github.actions.create_hosted_runner_for_org");
      expect(tool!.typing?.requiredInputKeys ?? []).toContain("org");
      expect(tool!.typing?.outputSchema).toBeDefined();
    },
    300_000,
  );

  test(
    "OpenAPI inventory mode still yields usable schemas",
    async () => {
      const cloudflareUrl = "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml";
      const prepared = await prepareOpenApiSpec(cloudflareUrl, "cloudflare", { includeDts: false, profile: "inventory" });
      expect(prepared.dts).toBeUndefined();

      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "cloudflare",
          spec: cloudflareUrl,
          baseUrl: prepared.servers[0] || "https://api.cloudflare.com/client/v4",
        },
        prepared,
      );

      expect(tools.length).toBeGreaterThan(0);
      const anyToolWithSchema = tools.find((t) => t.typing?.inputSchema && Object.keys(t.typing.inputSchema).length > 0);
      expect(anyToolWithSchema).toBeDefined();
      const anyToolWithTypedRef = tools.find((t) => t.typing?.typedRef);
      expect(anyToolWithTypedRef).toBeDefined();
    },
    300_000,
  );
});
