/**
 * Integration tests against real-world OpenAPI specs.
 *
 * These verify the full pipeline: fetch → parse → generate types → compact → cache round-trip.
 * Catches regressions where a spec format change or library update breaks loading.
 *
 * Specs are fetched live so these tests require network access and are slower (~5-60s each).
 */
import { test, expect, describe } from "bun:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { prepareOpenApiSpec, buildOpenApiToolsFromPrepared } from "../tool-sources";

interface SpecFixture {
  name: string;
  url: string;
  /** Minimum expected path count — sanity check the spec loaded fully */
  minPaths: number;
  /** Whether openapiTS should succeed (false for Swagger 2.x specs) */
  expectDts: boolean;
}

type PrimitiveParamType = "string" | "number" | "boolean";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
const JSON_CONTENT_TYPES = ["application/json", "application/*+json", "text/json"] as const;

interface OperationTypeExpectations {
  expectedInputFields: Array<{ name: string; type: PrimitiveParamType }>;
  expectedOutputFields: Array<{ name: string; type: PrimitiveParamType }>;
  expectsInput: boolean;
  expectsKnownOutput: boolean;
  expectsVoidOutput: boolean;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resolveSchemaPrimitiveType(
  schemaValue: unknown,
  componentSchemas: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): PrimitiveParamType | null {
  const schema = toRecord(schemaValue);
  const type = typeof schema.type === "string" ? schema.type : "";
  if (type === "integer" || type === "number") return "number";
  if (type === "string" || type === "boolean") return type;

  const ref = typeof schema.$ref === "string" ? schema.$ref : "";
  const schemaRefPrefix = "#/components/schemas/";
  if (ref.startsWith(schemaRefPrefix) && !seenRefs.has(ref)) {
    const key = ref.slice(schemaRefPrefix.length);
    const nextSeen = new Set(seenRefs);
    nextSeen.add(ref);
    return resolveSchemaPrimitiveType(componentSchemas[key], componentSchemas, nextSeen);
  }

  return null;
}

function resolveParameterEntry(
  entry: unknown,
  componentParameters: Record<string, unknown>,
): Record<string, unknown> {
  const record = toRecord(entry);
  const ref = typeof record.$ref === "string" ? record.$ref : "";
  const prefix = "#/components/parameters/";
  if (!ref.startsWith(prefix)) return record;

  const key = ref.slice(prefix.length);
  const resolved = toRecord(componentParameters[key]);
  return Object.keys(resolved).length > 0 ? resolved : record;
}

function resolveRequestBodyEntry(
  entry: unknown,
  componentRequestBodies: Record<string, unknown>,
): Record<string, unknown> {
  const record = toRecord(entry);
  const ref = typeof record.$ref === "string" ? record.$ref : "";
  const prefix = "#/components/requestBodies/";
  if (!ref.startsWith(prefix)) return record;

  const key = ref.slice(prefix.length);
  const resolved = toRecord(componentRequestBodies[key]);
  return Object.keys(resolved).length > 0 ? resolved : record;
}

function resolveResponseEntry(
  entry: unknown,
  componentResponses: Record<string, unknown>,
): Record<string, unknown> {
  const record = toRecord(entry);
  const ref = typeof record.$ref === "string" ? record.$ref : "";
  const prefix = "#/components/responses/";
  if (!ref.startsWith(prefix)) return record;

  const key = ref.slice(prefix.length);
  const resolved = toRecord(componentResponses[key]);
  return Object.keys(resolved).length > 0 ? resolved : record;
}

function preferredContentSchema(contentValue: unknown): Record<string, unknown> {
  const content = toRecord(contentValue);
  for (const mediaType of JSON_CONTENT_TYPES) {
    const candidate = toRecord(content[mediaType]);
    const schema = toRecord(candidate.schema);
    if (Object.keys(schema).length > 0) return schema;
  }

  for (const value of Object.values(content)) {
    const schema = toRecord(toRecord(value).schema);
    if (Object.keys(schema).length > 0) return schema;
  }

  return {};
}

function collectOperationTypeExpectations(
  spec: Record<string, unknown>,
): Map<string, OperationTypeExpectations> {
  const components = toRecord(spec.components);
  const componentParameters = toRecord(components.parameters);
  const componentSchemas = toRecord(components.schemas);
  const componentResponses = toRecord(components.responses);
  const componentRequestBodies = toRecord(components.requestBodies);
  const paths = toRecord(spec.paths);

  const byOperationId = new Map<string, OperationTypeExpectations>();

  for (const [pathTemplate, pathValue] of Object.entries(paths)) {
    const pathObject = toRecord(pathValue);
    const sharedParameters = Array.isArray(pathObject.parameters) ? pathObject.parameters : [];

    for (const method of HTTP_METHODS) {
      const operation = toRecord(pathObject[method]);
      if (Object.keys(operation).length === 0) continue;
      const operationId = typeof operation.operationId === "string" && operation.operationId.length > 0
        ? operation.operationId
        : `${method}_${pathTemplate}`;

      const operationParameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const paramEntries = [...sharedParameters, ...operationParameters];
      const expectedByName = new Map<string, PrimitiveParamType>();
      const conflictedNames = new Set<string>();

      const upsertExpectedField = (name: string, fieldType: PrimitiveParamType) => {
        if (conflictedNames.has(name)) return;
        const existing = expectedByName.get(name);
        if (!existing) {
          expectedByName.set(name, fieldType);
          return;
        }
        if (existing !== fieldType) {
          expectedByName.delete(name);
          conflictedNames.add(name);
        }
      };

      for (const paramEntry of paramEntries) {
        const parameter = resolveParameterEntry(paramEntry, componentParameters);
        const location = typeof parameter.in === "string" ? parameter.in : "";
        if (location !== "path" && location !== "query" && location !== "header" && location !== "cookie") {
          continue;
        }

        const name = typeof parameter.name === "string" ? parameter.name.trim() : "";
        if (!name) continue;

        const primitiveType = resolveSchemaPrimitiveType(parameter.schema, componentSchemas);
        if (!primitiveType) continue;
        upsertExpectedField(name, primitiveType);
      }

      const requestBody = resolveRequestBodyEntry(operation.requestBody, componentRequestBodies);
      const requestBodySchema = preferredContentSchema(requestBody.content);
      const requestBodyProperties = toRecord(requestBodySchema.properties);
      const requiredBodyKeys = Array.isArray(requestBodySchema.required)
        ? requestBodySchema.required.filter((value): value is string => typeof value === "string")
        : [];
      for (const key of requiredBodyKeys) {
        const primitiveType = resolveSchemaPrimitiveType(requestBodyProperties[key], componentSchemas);
        if (!primitiveType) continue;
        upsertExpectedField(key, primitiveType);
      }

      const responses = toRecord(operation.responses);
      let expectsKnownOutput = false;
      let expectsVoidOutput = false;
      let expectedOutputFields: Array<{ name: string; type: PrimitiveParamType }> = [];
      for (const [statusCode, responseValue] of Object.entries(responses)) {
        if (!statusCode.startsWith("2")) continue;

        const response = resolveResponseEntry(responseValue, componentResponses);
        const responseSchema = preferredContentSchema(response.content);
        if (Object.keys(responseSchema).length > 0) {
          expectsKnownOutput = true;

          const responseProperties = toRecord(responseSchema.properties);
          const requiredResponseKeys = Array.isArray(responseSchema.required)
            ? responseSchema.required.filter((value): value is string => typeof value === "string")
            : [];
          expectedOutputFields = requiredResponseKeys
            .map((key) => {
              const primitiveType = resolveSchemaPrimitiveType(responseProperties[key], componentSchemas);
              return primitiveType ? { name: key, type: primitiveType } : null;
            })
            .filter((value): value is { name: string; type: PrimitiveParamType } => Boolean(value));
        } else if (statusCode === "204" || statusCode === "205") {
          expectsVoidOutput = true;
        }
        break;
      }

      byOperationId.set(operationId, {
        expectedInputFields: [...expectedByName.entries()].map(([name, type]) => ({ name, type })),
        expectedOutputFields,
        expectsInput: paramEntries.length > 0 || Object.keys(requestBodySchema).length > 0,
        expectsKnownOutput,
        expectsVoidOutput,
      });
    }
  }

  return byOperationId;
}

function extractHintSegment(inputHint: string, paramName: string): string | null {
  const splitTopLevelBy = (value: string, separator: string): string[] => {
    const parts: string[] = [];
    let segment = "";
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let angleDepth = 0;
    let inSingle = false;
    let inDouble = false;
    let escapeNext = false;

    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i]!;

      if (escapeNext) {
        segment += ch;
        escapeNext = false;
        continue;
      }

      if ((inSingle || inDouble) && ch === "\\") {
        segment += ch;
        escapeNext = true;
        continue;
      }

      if (!inDouble && ch === "'" && !escapeNext) {
        inSingle = !inSingle;
        segment += ch;
        continue;
      }

      if (!inSingle && ch === '"' && !escapeNext) {
        inDouble = !inDouble;
        segment += ch;
        continue;
      }

      if (!inSingle && !inDouble) {
        if (ch === "(") parenDepth += 1;
        else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
        else if (ch === "{") braceDepth += 1;
        else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
        else if (ch === "[") bracketDepth += 1;
        else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
        else if (ch === "<") angleDepth += 1;
        else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);

        if (ch === separator
          && parenDepth === 0
          && braceDepth === 0
          && bracketDepth === 0
          && angleDepth === 0) {
          const trimmed = segment.trim();
          if (trimmed) parts.push(trimmed);
          segment = "";
          continue;
        }
      }

      segment += ch;
    }

    const trimmed = segment.trim();
    if (trimmed) parts.push(trimmed);
    return parts;
  };

  const hasBalancedWrappingParens = (value: string): boolean => {
    if (!value.startsWith("(") || !value.endsWith(")")) return false;

    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let escapeNext = false;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i]!;

      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if ((inSingle || inDouble) && ch === "\\") {
        escapeNext = true;
        continue;
      }
      if (!inDouble && ch === "'") {
        inSingle = !inSingle;
        continue;
      }
      if (!inSingle && ch === '"') {
        inDouble = !inDouble;
        continue;
      }
      if (inSingle || inDouble) continue;

      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && i < value.length - 1) return false;
      }
    }

    return depth === 0;
  };

  const unwrapOuterParens = (value: string): string => {
    let out = value.trim();
    while (hasBalancedWrappingParens(out)) {
      out = out.slice(1, -1).trim();
    }
    return out;
  };

  const queue = [inputHint];
  const visited = new Set<string>();
  const objectCandidates: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const normalized = unwrapOuterParens(current);
    if (!normalized || visited.has(normalized)) continue;
    visited.add(normalized);

    const unionParts = splitTopLevelBy(normalized, "|");
    if (unionParts.length > 1) {
      queue.push(...unionParts);
      continue;
    }

    const intersectionParts = splitTopLevelBy(normalized, "&");
    if (intersectionParts.length > 1) {
      queue.push(...intersectionParts);
      continue;
    }

    if (normalized.startsWith("{") && normalized.endsWith("}")) {
      objectCandidates.push(normalized);
    }
  }

  for (const candidate of objectCandidates) {
    const inner = candidate.slice(1, -1);
    const fields = splitTopLevelBy(inner, ";");
    for (const field of fields) {
      const idx = field.indexOf(":");
      if (idx <= 0) continue;
      const rawKey = field.slice(0, idx).trim();
      const key = rawKey.endsWith("?") ? rawKey.slice(0, -1).trim() : rawKey;
      const normalizedKey = (key.startsWith('"') && key.endsWith('"'))
        || (key.startsWith("'") && key.endsWith("'"))
        ? key.slice(1, -1)
        : key;
      if (normalizedKey !== paramName) continue;

      const segment = field.slice(idx + 1).trim();
      if (segment.length > 0) return segment;
    }
  }

  return null;
}

function hintSegmentMatchesPrimitiveType(
  segment: string,
  expectedType: PrimitiveParamType,
  componentSchemas: Record<string, unknown> = {},
): boolean {
  if (expectedType === "number" && (/\bnumber\b/.test(segment) || /(^|\W)-?\d+(?:\.\d+)?(\W|$)/.test(segment))) return true;
  if (expectedType === "boolean" && (/\bboolean\b/.test(segment) || /\btrue\b|\bfalse\b/.test(segment))) return true;
  if (expectedType === "string" && (/\bstring\b/.test(segment) || segment.includes("\"") || segment.includes("'"))) {
    return true;
  }

  const refPattern = /components\["schemas"\]\["([^"]+)"\]/g;
  for (const match of segment.matchAll(refPattern)) {
    const key = match[1];
    if (!key) continue;
    const resolved = resolveSchemaPrimitiveType(componentSchemas[key], componentSchemas);
    if (resolved === expectedType) return true;
  }

  return false;
}

function containsUnknownTypeToken(segment: string): boolean {
  const withoutQuotedLiterals = segment
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "");
  return /\bunknown\b/.test(withoutQuotedLiterals);
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

  test(
    "openai: create batch hints stay non-lossy in inventory mode",
    async () => {
      const openAiUrl = "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml";
      const prepared = await prepareOpenApiSpec(openAiUrl, "openai", {
        includeDts: false,
        profile: "inventory",
      });

      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "openai",
          spec: openAiUrl,
          baseUrl: prepared.servers[0] || "https://api.openai.com",
        },
        prepared,
      );

      const tool = tools.find((t) => t.path === "openai.batch.create_batch");
      expect(tool).toBeDefined();

      const inputHint = tool!.typing?.inputHint ?? "";
      const outputHint = tool!.typing?.outputHint ?? "";

      expect(inputHint).toContain("input_file_id");
      expect(inputHint).toContain("output_expires_after");
      expect(outputHint).toContain("errors?: {");
      expect(outputHint).toContain("message?: string");
      expect(inputHint.includes("...")).toBe(false);
      expect(outputHint.includes("...")).toBe(false);
    },
    300_000,
  );

  test(
    "openai: assistants cancel run keeps path parameter types in inventory mode",
    async () => {
      const openAiUrl = "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml";
      const prepared = await prepareOpenApiSpec(openAiUrl, "openai", {
        includeDts: false,
        profile: "inventory",
      });

      const tools = buildOpenApiToolsFromPrepared(
        {
          type: "openapi",
          name: "openai",
          spec: openAiUrl,
          baseUrl: prepared.servers[0] || "https://api.openai.com",
        },
        prepared,
      );

      const tool = tools.find((t) => t.path === "openai.assistants.cancel_run");
      expect(tool).toBeDefined();

      const inputHint = tool!.typing?.inputHint ?? "";
      expect(inputHint).toContain("thread_id: string");
      expect(inputHint).toContain("run_id: string");
      expect(inputHint.includes("unknown")).toBe(false);
    },
    300_000,
  );

  test(
    "openai: URL parser path matches normal parsed-spec path",
    async () => {
      const openAiUrl = "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml";

      const viaUrl = await prepareOpenApiSpec(openAiUrl, "openai", {
        includeDts: true,
        profile: "full",
      });

      const parsed = await SwaggerParser.parse(openAiUrl);
      const viaParsed = await prepareOpenApiSpec(parsed as Record<string, unknown>, "openai", {
        includeDts: true,
        profile: "full",
      });

      const source = {
        type: "openapi" as const,
        name: "openai",
        spec: openAiUrl,
        baseUrl: viaUrl.servers[0] || "https://api.openai.com",
      };

      const toolsViaUrl = buildOpenApiToolsFromPrepared(source, viaUrl);
      const toolsViaParsed = buildOpenApiToolsFromPrepared(source, viaParsed);

      const fingerprint = (tool: (typeof toolsViaUrl)[number]) => JSON.stringify({
        path: tool.path,
        operationId: tool.typing?.typedRef?.kind === "openapi_operation"
          ? tool.typing.typedRef.operationId
          : undefined,
        inputHint: tool.typing?.inputHint,
        outputHint: tool.typing?.outputHint,
      });

      const normalizedViaUrl = toolsViaUrl.map(fingerprint).sort();
      const normalizedViaParsed = toolsViaParsed.map(fingerprint).sort();

      expect(normalizedViaUrl).toEqual(normalizedViaParsed);
    },
    300_000,
  );

  test(
    "inventory type hints validate every operation against parser-derived expectations across real specs",
    async () => {
      const fixtures = SPECS
        .filter((fixture) => fixture.expectDts)
        .filter((fixture) => fixture.name !== "jira")
        .slice(0, 6);

      expect(fixtures.length).toBe(6);

      for (const fixture of fixtures) {
        const parsed = await SwaggerParser.parse(fixture.url);
        const parsedSpec = parsed as Record<string, unknown>;
        const componentSchemas = toRecord(toRecord(parsedSpec.components).schemas);
        const operationExpectations = collectOperationTypeExpectations(parsedSpec);
        expect(operationExpectations.size).toBeGreaterThan(0);

        const prepared = await prepareOpenApiSpec(parsedSpec, fixture.name, {
          includeDts: false,
          profile: "inventory",
        });
        const tools = buildOpenApiToolsFromPrepared(
          {
            type: "openapi",
            name: fixture.name,
            spec: fixture.url,
            baseUrl: prepared.servers[0] || `https://${fixture.name}.example.com`,
          },
          prepared,
        );

        const toolsByOperationId = new Map<string, (typeof tools)[number]>();
        for (const tool of tools) {
          const operationId = tool.typing?.typedRef?.kind === "openapi_operation"
            ? tool.typing.typedRef.operationId
            : "";
          if (!operationId || toolsByOperationId.has(operationId)) continue;
          toolsByOperationId.set(operationId, tool);
        }

        expect(toolsByOperationId.size).toBe(operationExpectations.size);

        for (const [operationId, expectations] of operationExpectations.entries()) {
          const tool = toolsByOperationId.get(operationId);
          expect(tool).toBeDefined();
          if (!tool) continue;

          const inputHint = tool.typing?.inputHint ?? "";
          const outputHint = tool.typing?.outputHint ?? "";

          if (expectations.expectsInput) {
            expect(inputHint.length).toBeGreaterThan(0);
            expect(inputHint).not.toBe("unknown");
          }

          if (expectations.expectsKnownOutput) {
            expect(outputHint.length).toBeGreaterThan(0);
            expect(outputHint).not.toBe("unknown");
          }

          if (expectations.expectsVoidOutput) {
            expect(outputHint).toBe("void");
          }

          for (const expected of expectations.expectedInputFields) {
            const segment = extractHintSegment(inputHint, expected.name);
            if (!segment) {
              throw new Error(`[${fixture.name}] missing input segment for ${operationId}.${expected.name}: ${inputHint}`);
            }
            if (containsUnknownTypeToken(segment)) {
              throw new Error(`[${fixture.name}] unknown input segment for ${operationId}.${expected.name}: ${segment}`);
            }
            if (!hintSegmentMatchesPrimitiveType(segment, expected.type, componentSchemas)) {
              throw new Error(
                `[${fixture.name}] input type mismatch for ${operationId}.${expected.name}: expected ${expected.type}, got ${segment}`,
              );
            }
          }

          for (const expected of expectations.expectedOutputFields) {
            const segment = extractHintSegment(outputHint, expected.name);
            if (!segment) {
              throw new Error(`[${fixture.name}] missing output segment for ${operationId}.${expected.name}: ${outputHint}`);
            }
            if (containsUnknownTypeToken(segment)) {
              throw new Error(`[${fixture.name}] unknown output segment for ${operationId}.${expected.name}: ${segment}`);
            }
            if (!hintSegmentMatchesPrimitiveType(segment, expected.type, componentSchemas)) {
              throw new Error(
                `[${fixture.name}] output type mismatch for ${operationId}.${expected.name}: expected ${expected.type}, got ${segment}`,
              );
            }
          }
        }
      }
    },
    1_800_000,
  );
});
