/**
 * Integration tests against real-world OpenAPI specs.
 *
 * These verify the full pipeline: fetch → parse → generate types → compact → cache round-trip.
 * Catches regressions where a spec format change or library update breaks loading.
 *
 * Specs are fetched live so these tests require network access and are slower (~5-60s each).
 */
import { test, expect, describe } from "bun:test";
import { prepareOpenApiSpec, buildOpenApiToolsFromPrepared } from "./tool-sources";
import { generateToolDeclarations, typecheckCode } from "./typechecker";
import type { ToolDefinition, ToolDescriptor } from "./types";

function compareStrictHintsToOpenApiTypes(
  tool: ToolDefinition,
  sourceName: string,
  sourceDts: string,
) {
  const operationId = tool.metadata?.operationId;
  if (!operationId) {
    throw new Error(`Tool ${tool.path} is missing operationId`);
  }

  const descriptor: ToolDescriptor = {
    path: tool.path,
    description: tool.description,
    approval: tool.approval,
    source: tool.source,
    operationId,
    argsType: tool.metadata?.displayArgsType,
    returnsType: tool.metadata?.displayReturnsType,
    strictArgsType: tool.metadata?.argsType,
    strictReturnsType: tool.metadata?.returnsType,
  };

  const declarations = generateToolDeclarations([descriptor], {
    sourceDtsBySource: {
      [`openapi:${sourceName}`]: sourceDts,
    },
  });

  const strictArgs = tool.metadata?.argsType ?? "{}";
  const strictReturns = tool.metadata?.returnsType ?? "unknown";
  const code = [
    `type GeneratedInput = ToolInput<operations[${JSON.stringify(operationId)}]>`,
    `type StrictInput = ${strictArgs}`,
    "const _inputA: GeneratedInput = {} as StrictInput",
    "const _inputB: StrictInput = {} as GeneratedInput",
    `type GeneratedOutput = ToolOutput<operations[${JSON.stringify(operationId)}]>`,
    `type StrictOutput = ${strictReturns}`,
    "const _outputA: GeneratedOutput = {} as StrictOutput",
    "const _outputB: StrictOutput = {} as GeneratedOutput",
    "return true;",
  ].join("\n");

  return typecheckCode(code, declarations);
}

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

          // Real specs should produce useful type hints for at least some operations.
          const typedInputs = tools.filter(
            (t) => t.metadata?.argsType && t.metadata.argsType !== "Record<string, unknown>",
          );
          const typedOutputs = tools.filter(
            (t) => t.metadata?.returnsType && t.metadata.returnsType !== "unknown",
          );
          expect(typedInputs.length).toBeGreaterThan(0);
          expect(typedOutputs.length).toBeGreaterThan(0);
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
        (t) => t.metadata?.operationId === "activity/delete-repo-subscription",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("github.activity.delete_repo_subscription");
      expect(tool!.metadata!.argsType).toContain("owner");
      expect(tool!.metadata!.argsType).toContain("repo");
      expect(tool!.metadata!.argsType).not.toBe("Record<string, unknown>");
      expect(tool!.metadata!.returnsType).toBe("void");
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
        (t) => t.metadata?.operationId === "actions/add-custom-labels-to-self-hosted-runner-for-repo",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("github.actions.add_custom_labels_to_self_hosted_runner_for_repo");
      expect(tool!.metadata!.displayArgsType).toContain("owner: string");
      expect(tool!.metadata!.displayArgsType).toContain("repo: string");
      expect(tool!.metadata!.displayArgsType).toContain("runner_id: number");
      expect(tool!.metadata!.displayArgsType).toContain("labels: string[]");
      expect(tool!.metadata!.displayArgsType).not.toContain("owner: ...");
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
        (t) => t.metadata?.operationId === "actions/create-hosted-runner-for-org",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("github.actions.create_hosted_runner_for_org");
      expect(tool!.metadata!.argsType).toContain("org: string");
      expect(tool!.metadata!.returnsType).toContain("id");
      expect(tool!.metadata!.returnsType).not.toBe("unknown");
    },
    300_000,
  );

  test(
    "github: meta/get has empty object input hint",
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

      const tool = tools.find((t) => t.metadata?.operationId === "meta/get");

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("github.meta.get");
      expect(tool!.metadata!.argsType).toBe("{}");
    },
    300_000,
  );

  test(
    "github: all budgets for org has non-unknown return hint",
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
        (t) => t.metadata?.operationId === "billing/get-all-budgets-org",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("github.billing.get_all_budgets_org");
      expect(tool!.metadata!.argsType).toContain("org: string");
      expect(tool!.metadata!.returnsType).toContain("budgets");
      expect(tool!.metadata!.returnsType).not.toBe("unknown");
    },
    300_000,
  );

  test(
    "slack: approved apps list keeps typed query params and non-unknown output",
    async () => {
      const slackUrl = "https://api.slack.com/specs/openapi/v2/slack_web.json";

      const prepared = await prepareOpenApiSpec(slackUrl, "slack");
      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "slack",
          spec: slackUrl,
          baseUrl: "https://slack.com/api",
        },
        prepared,
      );

      const tool = tools.find(
        (t) => t.metadata?.operationId === "admin_apps_approved_list",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("slack.admin_apps_approved.list");
      expect(tool!.metadata!.argsType).toContain("token: string");
      expect(tool!.metadata!.argsType).toContain("limit?: number");
      expect(tool!.metadata!.returnsType).not.toBe("unknown");
    },
    300_000,
  );

  test(
    "cloudflare: list health checks includes typed health check fields",
    async () => {
      const cloudflareUrl = "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml";

      const prepared = await prepareOpenApiSpec(cloudflareUrl, "cloudflare");
      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "cloudflare",
          spec: cloudflareUrl,
          baseUrl: prepared.servers[0] || "https://api.cloudflare.com/client/v4",
        },
        prepared,
      );

      const tool = tools.find(
        (t) => t.metadata?.operationId === "health-checks-list-health-checks",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("cloudflare.health_checks.list_health_checks");
      expect(tool!.metadata!.returnsType).toContain("address?: string");
      expect(tool!.metadata!.returnsType).toContain("id?: string");
      expect(tool!.metadata!.returnsType).toContain("interval?: number");
    },
    300_000,
  );

  test(
    "cloudflare inventory mode: access apps keeps typed args and non-unknown returns",
    async () => {
      const cloudflareUrl = "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml";

      const prepared = await prepareOpenApiSpec(cloudflareUrl, "cloudflare", { includeDts: false });
      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "cloudflare",
          spec: cloudflareUrl,
          baseUrl: prepared.servers[0] || "https://api.cloudflare.com/client/v4",
        },
        prepared,
      );

      const tool = tools.find(
        (t) => t.metadata?.operationId === "access-applications-list-access-applications",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("cloudflare.access_applications.list_access_applications");
      expect(tool!.metadata!.argsType).toContain("account_id: string");
      expect(tool!.metadata!.argsType).not.toContain("account_id: unknown");
      expect(tool!.metadata!.returnsType).not.toBe("unknown");
    },
    300_000,
  );

  test(
    "cloudflare: access authentication logs keeps non-ellipsis compact hints",
    async () => {
      const cloudflareUrl = "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml";

      const prepared = await prepareOpenApiSpec(cloudflareUrl, "cloudflare", { includeDts: false });
      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "cloudflare",
          spec: cloudflareUrl,
          baseUrl: prepared.servers[0] || "https://api.cloudflare.com/client/v4",
        },
        prepared,
      );

      const tool = tools.find(
        (t) => t.metadata?.operationId === "access-authentication-logs-get-access-authentication-logs",
      );

      expect(tool).toBeDefined();
      expect(tool!.path).toBe("cloudflare.access_authentication_logs.get_access_authentication_logs");
      expect(tool!.metadata!.displayArgsType).toContain("account_id: string");
      expect(tool!.metadata!.displayArgsType).toContain("direction?: \"desc\" | \"asc\"");
      expect(tool!.metadata!.displayArgsType).not.toContain("...");
      expect(tool!.metadata!.displayReturnsType).toContain("messages: { code: number");
      expect(tool!.metadata!.displayReturnsType).toContain("result?: {");
      expect(tool!.metadata!.displayReturnsType).not.toContain("...");
    },
    300_000,
  );

  test(
    "cloudflare: delete access application keeps concrete compact args/returns",
    async () => {
      const cloudflareUrl = "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml";

      const prepared = await prepareOpenApiSpec(cloudflareUrl, "cloudflare", { includeDts: false });
      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "cloudflare",
          spec: cloudflareUrl,
          baseUrl: prepared.servers[0] || "https://api.cloudflare.com/client/v4",
        },
        prepared,
      );

      const tool = tools.find(
        (t) => t.metadata?.operationId === "access-applications-delete-an-access-application",
      );

      expect(tool).toBeDefined();
      expect(tool!.metadata!.displayArgsType).toBe("{ app_id: string; account_id: string }");
      expect(tool!.metadata!.displayArgsType).not.toContain("...");
      expect(tool!.metadata!.displayReturnsType).toContain("result?: { id?: string }");
      expect(tool!.metadata!.displayReturnsType).not.toContain("num...");
    },
    300_000,
  );

  test(
    "cloudflare: add access application type hints diverge from openapi-typescript canonical types",
    async () => {
      const cloudflareUrl = "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml";

      const prepared = await prepareOpenApiSpec(cloudflareUrl, "cloudflare");
      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "cloudflare",
          spec: cloudflareUrl,
          baseUrl: prepared.servers[0] || "https://api.cloudflare.com/client/v4",
        },
        prepared,
      );

      const tool = tools.find(
        (t) => t.metadata?.operationId === "access-applications-add-an-application",
      );

      expect(tool).toBeDefined();
      expect(prepared.dts).toBeDefined();

      const comparison = compareStrictHintsToOpenApiTypes(tool!, "cloudflare", prepared.dts!);

      // Reproduces the current mismatch between fallback strict hints and generated operation types.
      expect(comparison.ok).toBe(false);
      expect(
        comparison.errors.some((error) => error.includes("allowed_methods") || error.includes("target_criteria")),
      ).toBe(true);

      // Ensure UI/discovery hints remain compact even when strict hints are very large.
      expect(tool!.metadata!.displayArgsType).toContain("account_id");
      expect(tool!.metadata!.displayArgsType!.length).toBeLessThan(240);
      expect(tool!.metadata!.argsType!.length).toBeGreaterThan(8_000);
    },
    300_000,
  );
});
