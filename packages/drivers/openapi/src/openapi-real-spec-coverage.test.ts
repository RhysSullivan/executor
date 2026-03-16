import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { compileOpenApiToolDefinitions } from "./openapi-definitions";
import { parseOpenApiDocument } from "./openapi-document";
import { extractOpenApiManifest } from "./openapi-extraction";
import { buildOpenApiToolPresentation } from "./openapi-tool-presentation";
import type {
  OpenApiExtractedTool,
  OpenApiJsonObject,
  OpenApiToolManifest,
} from "./openapi-types";

const readFixture = (name: string): string =>
  readFileSync(
    new URL(`../../../platform/control-plane/src/runtime/fixtures/${name}`, import.meta.url),
    "utf8",
  );

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const pointerSegment = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

const resolveLocalRef = (
  document: OpenApiJsonObject,
  value: unknown,
  activeRefs: ReadonlySet<string> = new Set<string>(),
): unknown => {
  const object = asObject(value);
  const ref = typeof object.$ref === "string" ? object.$ref : null;
  if (!ref || !ref.startsWith("#/") || activeRefs.has(ref)) {
    return value;
  }

  const resolved = ref
    .slice(2)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (current === undefined || current === null) {
        return undefined;
      }

      return asObject(current)[pointerSegment(segment)];
    }, document);

  if (resolved === undefined) {
    return value;
  }

  const nextActiveRefs = new Set(activeRefs);
  nextActiveRefs.add(ref);
  const resolvedObject = asObject(resolveLocalRef(document, resolved, nextActiveRefs));
  const { $ref: _ignoredRef, ...rest } = object;

  return Object.keys(rest).length > 0
    ? { ...resolvedObject, ...rest }
    : resolvedObject;
};

const jsonContentSchema = (
  content: unknown,
): unknown | undefined => {
  const entries = Object.entries(asObject(content));
  const preferredEntry = entries.find(([mediaType]) => mediaType === "application/json")
    ?? entries.find(([mediaType]) => mediaType.toLowerCase().includes("+json"))
    ?? entries.find(([mediaType]) => mediaType.toLowerCase().includes("json"));

  return preferredEntry ? asObject(preferredEntry[1]).schema : undefined;
};

const operationForTool = (
  document: OpenApiJsonObject,
  tool: OpenApiExtractedTool,
): Record<string, unknown> =>
  asObject(asObject(asObject(document.paths)[tool.path])[tool.method]);

const requestBodySchemaForTool = (
  document: OpenApiJsonObject,
  tool: OpenApiExtractedTool,
): unknown | undefined => {
  const requestBody = resolveLocalRef(document, operationForTool(document, tool).requestBody);
  return jsonContentSchema(asObject(requestBody).content);
};

const responseSchemaForTool = (
  document: OpenApiJsonObject,
  tool: OpenApiExtractedTool,
): unknown | undefined => {
  const responseEntries = Object.entries(asObject(operationForTool(document, tool).responses));
  const preferredResponses = responseEntries
    .filter(([status]) => /^2\d\d$/.test(status))
    .sort(([left], [right]) => left.localeCompare(right));
  const fallbackResponses = responseEntries.filter(([status]) => status === "default");

  for (const [, responseValue] of [...preferredResponses, ...fallbackResponses]) {
    const response = resolveLocalRef(document, responseValue);
    const schema = jsonContentSchema(asObject(response).content);
    if (schema !== undefined) {
      return schema;
    }
  }

  return undefined;
};

const normalizeSchema = (
  document: OpenApiJsonObject,
  schema: unknown,
  depth: number = 4,
  activeRefs: ReadonlySet<string> = new Set<string>(),
): unknown => {
  if (depth < 0) {
    return "...";
  }

  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeSchema(document, entry, depth - 1, activeRefs));
  }

  const object = asObject(schema);
  const ref = typeof object.$ref === "string" ? object.$ref : null;
  if (ref && ref.startsWith("#/")) {
    if (activeRefs.has(ref)) {
      return { $ref: ref };
    }

    return normalizeSchema(
      document,
      resolveLocalRef(document, object, activeRefs),
      depth,
      new Set([...activeRefs, ref]),
    );
  }

  if (Object.keys(object).length === 0) {
    return object;
  }

  const normalized: Record<string, unknown> = {};

  if (typeof object.type === "string") {
    normalized.type = object.type;
  }
  if (typeof object.format === "string") {
    normalized.format = object.format;
  }
  if (typeof object.nullable === "boolean") {
    normalized.nullable = object.nullable;
  }
  if (object.const !== undefined) {
    normalized.const = object.const;
  }
  if (Array.isArray(object.enum)) {
    normalized.enum = [...object.enum];
  }
  if (Array.isArray(object.required)) {
    normalized.required = [...object.required].sort();
  }
  if (object.additionalProperties !== undefined) {
    normalized.additionalProperties =
      typeof object.additionalProperties === "boolean"
        ? object.additionalProperties
        : normalizeSchema(document, object.additionalProperties, depth - 1, activeRefs);
  }
  if (object.items !== undefined) {
    normalized.items = normalizeSchema(document, object.items, depth - 1, activeRefs);
  }
  if (Array.isArray(object.oneOf)) {
    normalized.oneOf = object.oneOf.map((entry) =>
      normalizeSchema(document, entry, depth - 1, activeRefs)
    );
  }
  if (Array.isArray(object.anyOf)) {
    normalized.anyOf = object.anyOf.map((entry) =>
      normalizeSchema(document, entry, depth - 1, activeRefs)
    );
  }
  if (Array.isArray(object.allOf)) {
    normalized.allOf = object.allOf.map((entry) =>
      normalizeSchema(document, entry, depth - 1, activeRefs)
    );
  }

  const properties = asObject(object.properties);
  if (Object.keys(properties).length > 0) {
    normalized.properties = Object.fromEntries(
      Object.keys(properties)
        .sort()
        .map((key) => [
          key,
          normalizeSchema(document, properties[key], depth - 1, activeRefs),
        ]),
    );
  }

  return normalized;
};

const schemaMatchesExpected = (expected: unknown, actual: unknown): boolean => {
  if (expected === actual) {
    return true;
  }

  if (
    expected !== null
    && typeof expected === "object"
    && !Array.isArray(expected)
    && typeof asObject(expected).$ref === "string"
  ) {
    return actual !== undefined;
  }

  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((entry, index) =>
        schemaMatchesExpected(entry, actual[index]),
      );
  }

  if (
    expected !== null
    && typeof expected === "object"
    && !Array.isArray(expected)
  ) {
    const expectedObject = asObject(expected);
    const actualObject = asObject(actual);

    return Object.entries(expectedObject).every(([key, value]) =>
      schemaMatchesExpected(value, actualObject[key]),
    );
  }

  return false;
};

const manifestToolMap = (
  manifest: OpenApiToolManifest,
): Map<string, OpenApiExtractedTool> =>
  new Map(
    manifest.tools.map((tool) => [`${tool.method} ${tool.path} ${tool.operationHash}`, tool]),
  );

const collectOpenApiPresentationMismatches = (input: {
  document: OpenApiJsonObject;
  manifest: OpenApiToolManifest;
}): string[] => {
  const manifestToolByKey = manifestToolMap(input.manifest);
  const mismatches: string[] = [];

  for (const definition of compileOpenApiToolDefinitions(input.manifest)) {
    const manifestTool = manifestToolByKey.get(
      `${definition.method} ${definition.path} ${definition.operationHash}`,
    );
    if (!manifestTool) {
      mismatches.push(`missing manifest tool for ${definition.toolId}`);
      continue;
    }

    const presentation = buildOpenApiToolPresentation({
      definition,
      refHintTable: input.manifest.refHintTable,
    });

    const expectedRequestSchema = requestBodySchemaForTool(input.document, manifestTool);
    if (expectedRequestSchema !== undefined) {
      const actualBodySchema = asObject(asObject(presentation.inputSchema).properties).body;
      if (actualBodySchema === undefined) {
        mismatches.push(`${definition.toolId}: missing body schema`);
      } else if (!schemaMatchesExpected(
        normalizeSchema(input.document, expectedRequestSchema),
        normalizeSchema(input.document, actualBodySchema),
      )) {
        mismatches.push(`${definition.toolId}: request body schema mismatch`);
      }

      if (manifestTool.typing?.inputSchema === undefined) {
        mismatches.push(`${definition.toolId}: missing typing.inputSchema`);
      }
    }

    const expectedResponseSchema = responseSchemaForTool(input.document, manifestTool);
    if (expectedResponseSchema !== undefined) {
      if (presentation.outputSchema === undefined) {
        mismatches.push(`${definition.toolId}: missing output schema`);
      } else if (!schemaMatchesExpected(
        normalizeSchema(input.document, expectedResponseSchema),
        normalizeSchema(input.document, presentation.outputSchema),
      )) {
        mismatches.push(`${definition.toolId}: response schema mismatch`);
      }

      if (manifestTool.typing?.outputSchema === undefined) {
        mismatches.push(`${definition.toolId}: missing typing.outputSchema`);
      }
    }
  }

  return mismatches;
};

describe("openapi real spec coverage", () => {
  for (const fixture of [
    {
      name: "Vercel",
      filename: "vercel-openapi.json",
      expectedMinimumTools: 250,
    },
    {
      name: "Neon",
      filename: "neon-openapi.json",
      expectedMinimumTools: 50,
    },
  ] as const) {
    it.effect(
      `projects every ${fixture.name} operation with request/response schemas that match the raw spec`,
      () =>
        Effect.gen(function* () {
          const specText = readFixture(fixture.filename);
          const document = parseOpenApiDocument(specText);
          const manifest = yield* extractOpenApiManifest(
            fixture.name.toLowerCase(),
            specText,
          );
          const mismatches = collectOpenApiPresentationMismatches({
            document,
            manifest,
          });

          expect(manifest.tools.length).toBeGreaterThan(fixture.expectedMinimumTools);
          expect(mismatches).toEqual([]);
        }),
      120_000,
    );
  }
});
