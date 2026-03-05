import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "@effect/vitest";
import {
  OPEN_API_HTTP_METHODS,
  OPEN_API_PARAMETER_LOCATIONS,
  type OpenApiToolManifest,
} from "@executor-v2/schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { extractOpenApiManifest } from "./openapi-extraction";

class OpenApiRealSpecTestError extends Data.TaggedError("OpenApiRealSpecTestError")<{
  stage: "fetch" | "parse_json" | "bundle" | "parse";
  specName: string;
  message: string;
}> {}

type SpecFixture = {
  name: string;
  url: string;
};

type ParsedOperation = {
  method: (typeof OPEN_API_HTTP_METHODS)[number];
  path: string;
  operationId?: string;
  pathItem: Record<string, unknown>;
  operation: Record<string, unknown>;
};

type ParsedParameter = {
  name: string;
  location: (typeof OPEN_API_PARAMETER_LOCATIONS)[number];
  required: boolean;
  schema?: unknown;
};

type ExpectedTyping = {
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  refHintKeys?: Array<string>;
};

type SwaggerParserInput = Parameters<typeof SwaggerParser.bundle>[0];

const fixtures: ReadonlyArray<SpecFixture> = [
  {
    name: "cloudflare",
    url: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
  },
  {
    name: "vercel",
    url: "https://openapi.vercel.sh/",
  },
  {
    name: "stripe",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isParameterLocation = (
  value: unknown,
): value is (typeof OPEN_API_PARAMETER_LOCATIONS)[number] =>
  typeof value === "string" &&
  (OPEN_API_PARAMETER_LOCATIONS as ReadonlyArray<string>).includes(value);

const operationSignature = (
  operation: Pick<ParsedOperation, "method" | "path">,
): string => `${operation.method} ${operation.path}`;

const toStableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(toStableValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    stable[key] = toStableValue(value[key]);
  }

  return stable;
};

const toStableJson = (value: unknown): string => JSON.stringify(toStableValue(value));

const collectRefKeys = (value: unknown, refs: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefKeys(item, refs);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const refValue = value.$ref;
  if (typeof refValue === "string" && refValue.startsWith("#/")) {
    refs.add(refValue);
  }

  for (const nested of Object.values(value)) {
    collectRefKeys(nested, refs);
  }
};

const resolveJsonPointer = (
  root: Record<string, unknown>,
  pointer: string,
): unknown | null => {
  if (!pointer.startsWith("#/")) {
    return null;
  }

  const parts = pointer
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));

  let current: unknown = root;

  for (const part of parts) {
    if (!isRecord(current)) {
      return null;
    }

    current = current[part];
    if (current === undefined) {
      return null;
    }
  }

  return current;
};

const pickSchemaFromContent = (content: unknown): unknown | null => {
  if (!isRecord(content)) {
    return null;
  }

  const preferred = ["application/json", ...Object.keys(content).sort()];
  const seen = new Set<string>();

  for (const mediaType of preferred) {
    if (seen.has(mediaType)) {
      continue;
    }

    seen.add(mediaType);
    const mediaTypeValue = content[mediaType];
    if (!isRecord(mediaTypeValue)) {
      continue;
    }

    if (mediaTypeValue.schema !== undefined) {
      return mediaTypeValue.schema;
    }
  }

  return null;
};

const responseStatusRank = (statusCode: string): number => {
  if (/^2\d\d$/.test(statusCode)) {
    return 0;
  }

  if (statusCode === "default") {
    return 1;
  }

  return 2;
};

const toParsedParameter = (value: unknown): ParsedParameter | null => {
  if (!isRecord(value)) {
    return null;
  }

  const name = value.name;
  const location = value.in;
  if (typeof name !== "string" || name.trim().length === 0 || !isParameterLocation(location)) {
    return null;
  }

  return {
    name: name.trim(),
    location,
    required: location === "path" || value.required === true,
    schema: value.schema,
  };
};

const mergeParameters = (
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): Array<ParsedParameter> => {
  const byKey = new Map<string, ParsedParameter>();

  const add = (candidate: unknown) => {
    if (!Array.isArray(candidate)) {
      return;
    }

    for (const parameterValue of candidate) {
      const parsed = toParsedParameter(parameterValue);
      if (!parsed) {
        continue;
      }

      byKey.set(`${parsed.location}:${parsed.name}`, parsed);
    }
  };

  add(pathItem.parameters);
  add(operation.parameters);

  return [...byKey.values()].sort((left, right) => {
    if (left.location === right.location) {
      return left.name.localeCompare(right.name);
    }

    return left.location.localeCompare(right.location);
  });
};

const extractRequestBodySchema = (
  operation: Record<string, unknown>,
): { schema: unknown; required: boolean } | null => {
  const requestBody = operation.requestBody;
  if (!isRecord(requestBody)) {
    return null;
  }

  const schema = pickSchemaFromContent(requestBody.content);
  if (schema === null) {
    return null;
  }

  return {
    schema,
    required: requestBody.required === true,
  };
};

const extractResponseSchema = (operation: Record<string, unknown>): unknown | null => {
  if (!isRecord(operation.responses)) {
    return null;
  }

  const responseCodes = Object.keys(operation.responses).sort(
    (left, right) => responseStatusRank(left) - responseStatusRank(right),
  );

  for (const responseCode of responseCodes) {
    const responseValue = operation.responses[responseCode];
    if (!isRecord(responseValue)) {
      continue;
    }

    const schema = pickSchemaFromContent(responseValue.content);
    if (schema !== null) {
      return schema;
    }
  }

  return null;
};

const buildExpectedTyping = (
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): ExpectedTyping | undefined => {
  const parameters = mergeParameters(pathItem, operation);
  const requestBody = extractRequestBodySchema(operation);
  const outputSchema = extractResponseSchema(operation);

  const properties: Record<string, unknown> = {};
  const required = new Set<string>();

  for (const parameter of parameters) {
    properties[parameter.name] = parameter.schema ?? { type: "string" };
    if (parameter.required) {
      required.add(parameter.name);
    }
  }

  if (requestBody !== null) {
    properties.body = requestBody.schema;
    if (requestBody.required) {
      required.add("body");
    }
  }

  const inputSchema =
    Object.keys(properties).length > 0
      ? {
          type: "object",
          properties,
          required: [...required].sort(),
          additionalProperties: false,
        }
      : null;

  if (inputSchema === null && outputSchema === null) {
    return undefined;
  }

  const refs = new Set<string>();
  if (inputSchema !== null) {
    collectRefKeys(inputSchema, refs);
  }

  if (outputSchema !== null) {
    collectRefKeys(outputSchema, refs);
  }

  const refHintKeys = [...refs].sort();

  return {
    inputSchemaJson: inputSchema ? toStableJson(inputSchema) : undefined,
    outputSchemaJson: outputSchema ? toStableJson(outputSchema) : undefined,
    refHintKeys: refHintKeys.length > 0 ? refHintKeys : undefined,
  };
};

const collectOperationsFromSpec = (spec: unknown): Array<ParsedOperation> => {
  if (!isRecord(spec) || !isRecord(spec.paths)) {
    return [];
  }

  const operations: Array<ParsedOperation> = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!isRecord(pathItem)) {
      continue;
    }

    for (const method of OPEN_API_HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) {
        continue;
      }

      const operationIdRaw = operation.operationId;
      const operationId =
        typeof operationIdRaw === "string" && operationIdRaw.trim().length > 0
          ? operationIdRaw.trim()
          : undefined;

      operations.push({
        method,
        path,
        operationId,
        pathItem,
        operation,
      });
    }
  }

  operations.sort((left, right) =>
    operationSignature(left).localeCompare(operationSignature(right)),
  );

  return operations;
};

const collectOperationsFromManifest = (
  manifest: OpenApiToolManifest,
): Array<ParsedOperation> =>
  manifest.tools
    .map((tool) => ({
      method: tool.method,
      path: tool.path,
      operationId: tool.toolId,
      pathItem: {},
      operation: {},
    }))
    .sort((left, right) =>
      operationSignature(left).localeCompare(operationSignature(right)),
    );

const fetchSpecJson = (
  fixture: SpecFixture,
): Effect.Effect<unknown, OpenApiRealSpecTestError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(fixture.url),
      catch: (cause) =>
        new OpenApiRealSpecTestError({
          stage: "fetch",
          specName: fixture.name,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    if (!response.ok) {
      return yield* new OpenApiRealSpecTestError({
        stage: "fetch",
        specName: fixture.name,
        message: `HTTP ${response.status} ${response.statusText}`,
      });
    }

    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        new OpenApiRealSpecTestError({
          stage: "parse_json",
          specName: fixture.name,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  });

const loadParserDocument = (
  fixture: SpecFixture,
  specJson: unknown,
): Effect.Effect<unknown, OpenApiRealSpecTestError> =>
  Effect.gen(function* () {
    const parserInput = specJson as SwaggerParserInput;

    const bundledAttempt = yield* Effect.tryPromise({
      try: () => SwaggerParser.bundle(parserInput),
      catch: (cause) =>
        new OpenApiRealSpecTestError({
          stage: "bundle",
          specName: fixture.name,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.either);

    if (bundledAttempt._tag === "Right") {
      return bundledAttempt.right;
    }

    return yield* Effect.tryPromise({
      try: () => SwaggerParser.parse(parserInput),
      catch: (cause) =>
        new OpenApiRealSpecTestError({
          stage: "parse",
          specName: fixture.name,
          message: `bundle failed (${bundledAttempt.left.message}); parse failed (${cause instanceof Error ? cause.message : String(cause)})`,
        }),
    });
  });

describe("extractOpenApiManifest real specs parity", () => {
  for (const fixture of fixtures) {
    it.effect(
      `matches parser operation and typing inventory for ${fixture.name}`,
      () =>
        Effect.gen(function* () {
          const specJson = yield* fetchSpecJson(fixture);
          const parserDocument = yield* loadParserDocument(fixture, specJson);

          const parserOperations = collectOperationsFromSpec(parserDocument);
          const parserSignatures = parserOperations.map(operationSignature);

          const manifest = yield* extractOpenApiManifest(fixture.name, specJson);
          const extractedOperations = collectOperationsFromManifest(manifest);
          const extractedSignatures = extractedOperations.map(operationSignature);

          expect(manifest.tools.length).toBe(parserOperations.length);
          expect(extractedSignatures.length).toBe(parserSignatures.length);
          expect(extractedSignatures).toEqual(parserSignatures);

          const extractedByToolId = new Map(
            manifest.tools.map((tool) => [tool.toolId, tool] as const),
          );

          for (const operation of parserOperations) {
            if (!operation.operationId) {
              continue;
            }

            const extractedTool = extractedByToolId.get(operation.operationId);
            expect(extractedTool).toBeDefined();
            expect(extractedTool?.method).toBe(operation.method);
            expect(extractedTool?.path).toBe(operation.path);
            expect(extractedTool?.invocation.method).toBe(operation.method);
            expect(extractedTool?.invocation.pathTemplate).toBe(operation.path);

            const expectedTyping = buildExpectedTyping(
              operation.pathItem,
              operation.operation,
            );

            if (!expectedTyping) {
              expect(extractedTool?.typing).toBeUndefined();
              continue;
            }

            expect(extractedTool?.typing).toBeDefined();
            expect(extractedTool?.typing?.inputSchemaJson).toBe(
              expectedTyping.inputSchemaJson,
            );
            expect(extractedTool?.typing?.outputSchemaJson).toBe(
              expectedTyping.outputSchemaJson,
            );
            expect(extractedTool?.typing?.refHintKeys).toEqual(
              expectedTyping.refHintKeys,
            );
          }

          const referencedRefKeys = new Set<string>();
          for (const tool of manifest.tools) {
            for (const refKey of tool.typing?.refHintKeys ?? []) {
              referencedRefKeys.add(refKey);
            }
          }

          expect(Object.keys(manifest.refHintTable ?? {}).length).toBeGreaterThanOrEqual(
            referencedRefKeys.size,
          );

          if (isRecord(specJson)) {
            for (const refKey of referencedRefKeys) {
              const hint = manifest.refHintTable?.[refKey];
              expect(hint).toBeDefined();

              const resolved = resolveJsonPointer(specJson, refKey);
              if (resolved !== null) {
                expect(hint).toBe(toStableJson(resolved));
              }
            }
          }
        }),
      120_000,
    );
  }
});
