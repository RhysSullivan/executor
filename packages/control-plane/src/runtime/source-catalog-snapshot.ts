import { sha256Hex } from "@executor/codemode-core";
import {
  type OpenApiToolProviderData,
} from "@executor/codemode-openapi";
import {
  type GoogleDiscoveryToolProviderData,
} from "@executor/codemode-google-discovery";
import type {
  McpServerMetadata,
  McpToolAnnotations,
  McpToolExecution,
} from "@executor/codemode-mcp";

import type { Source } from "#schema";

import {
  createCatalogSnapshotV1,
  createEmptyCatalogV1,
} from "../ir/catalog";
import {
  CapabilityIdSchema,
  DiagnosticIdSchema,
  DocumentIdSchema,
  ExampleSymbolIdSchema,
  ExecutableIdSchema,
  HeaderSymbolIdSchema,
  ParameterSymbolIdSchema,
  RequestBodySymbolIdSchema,
  ResourceIdSchema,
  ResponseSetIdSchema,
  ResponseSymbolIdSchema,
  ScopeIdSchema,
  SecuritySchemeSymbolIdSchema,
  ShapeSymbolIdSchema,
} from "../ir/ids";
import type {
  AuthRequirement,
  Capability,
  CatalogSnapshotV1,
  CatalogV1,
  ContentSpec,
  DocumentationBlock,
  EffectKind,
  ExampleSymbol,
  GraphQLExecutable,
  HttpExecutable,
  ImportDiagnostic,
  McpExecutable,
  NativeBlob,
  ParameterSymbol,
  ProvenanceRef,
  ResponseSet,
  ResponseSymbol,
  Scope,
  SecuritySchemeSymbol,
  ShapeNode,
  ShapeSymbol,
  SourceKind,
  SourceDocument,
} from "../ir/model";
import type { GraphqlToolProviderData } from "./graphql-tools";
import { namespaceFromSourceName } from "./source-names";

type JsonSchema = boolean | Record<string, unknown>;

export type CatalogSourceDocumentInput = {
  documentKind: string;
  documentKey: string;
  contentText: string;
  fetchedAt?: number | null;
};

type CatalogOperationInput = {
  toolId: string;
  title?: string | null;
  description?: string | null;
  effect: EffectKind;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

export type OpenApiCatalogOperationInput = CatalogOperationInput & {
  providerData: OpenApiToolProviderData;
};

export type GoogleDiscoveryCatalogOperationInput = CatalogOperationInput & {
  providerData: GoogleDiscoveryToolProviderData;
};

export type GraphqlCatalogOperationInput = CatalogOperationInput & {
  providerData: GraphqlToolProviderData;
};

export type McpCatalogOperationInput = CatalogOperationInput & {
  providerData: {
    toolId: string;
    toolName: string;
    displayTitle: string;
    title: string | null;
    description: string | null;
    annotations: McpToolAnnotations | null;
    execution: McpToolExecution | null;
    icons: unknown[] | null;
    meta: unknown;
    rawTool: unknown;
    server: McpServerMetadata | null;
  };
};

type JsonSchemaImporter = {
  importSchema: (schema: unknown, key: string, rootSchema?: unknown) => ReturnType<typeof ShapeSymbolIdSchema.make>;
  finalize: () => void;
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
};

const stableHash = (value: unknown): string =>
  sha256Hex(stableStringify(value)).slice(0, 16);

const mutableRecord = <K extends string, V>(value: Readonly<Record<K, V>>): Record<K, V> =>
  value as unknown as Record<K, V>;

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const asBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const asStringArray = (value: unknown): string[] =>
  asArray(value).flatMap((entry) => {
    const stringValue = asString(entry);
    return stringValue === null ? [] : [stringValue];
  });

const sourceKindFromSource = (source: Source): SourceKind => {
  switch (source.kind) {
    case "openapi":
      return "openapi";
    case "graphql":
      return "graphql-schema";
    case "google_discovery":
      return "google-discovery";
    case "mcp":
      return "mcp";
    default:
      return "custom";
  }
};

const toolPathSegments = (source: Source, toolId: string): string[] => {
  const namespace = source.namespace ?? namespaceFromSourceName(source.name);
  const fullPath = namespace ? `${namespace}.${toolId}` : toolId;
  return fullPath.split(".").filter((segment) => segment.length > 0);
};

const serviceScopeIdForSource = (source: Source) =>
  ScopeIdSchema.make(`scope_service_${stableHash({ sourceId: source.id })}`);

const documentIdFor = (source: Source, key: string) =>
  DocumentIdSchema.make(`doc_${stableHash({ sourceId: source.id, key })}`);

const resourceIdForSource = (source: Source) =>
  ResourceIdSchema.make(`res_${stableHash({ sourceId: source.id })}`);

const provenanceFor = (documentId: ReturnType<typeof DocumentIdSchema.make>, pointer: string): ProvenanceRef[] => [{
  relation: "declared",
  documentId,
  pointer,
}];

const effectFromOperationKind = (operationKind: string): EffectKind => {
  switch (operationKind) {
    case "read":
      return "read";
    case "delete":
      return "delete";
    case "write":
      return "write";
    default:
      return "action";
  }
};

const interactionForEffect = (effect: EffectKind): Capability["interaction"] => ({
  approval: {
    mayRequire: effect !== "read",
    reasons:
      effect === "delete"
        ? ["delete"]
        : effect === "write" || effect === "action"
          ? ["write"]
          : [],
  },
  elicitation: {
    mayRequest: false,
  },
  resume: {
    supported: false,
  },
});

const mcpResumeSupport = (
  execution: McpCatalogOperationInput["providerData"]["execution"],
): boolean =>
  execution?.taskSupport === "optional" || execution?.taskSupport === "required";

const mcpSemanticsForOperation = (input: {
  effect: EffectKind;
  annotations: McpCatalogOperationInput["providerData"]["annotations"];
}): Capability["semantics"] => {
  const safe = input.effect === "read";

  return {
    effect: input.effect,
    safe,
    idempotent: safe || input.annotations?.idempotentHint === true,
    destructive:
      safe
        ? false
        : input.annotations?.destructiveHint !== false,
  };
};

const importMetadataFor = (input: {
  source: Source;
  adapterKey: string;
}) => ({
  sourceKind: sourceKindFromSource(input.source),
  adapterKey: input.adapterKey,
  importerVersion: "ir.v1.snapshot_builder",
  importedAt: new Date().toISOString(),
  sourceConfigHash:
    input.source.sourceHash
    ?? stableHash({
      endpoint: input.source.endpoint,
      binding: input.source.binding,
      auth: input.source.auth.kind,
    }),
});

const addDiagnostic = (
  catalog: CatalogV1,
  input: Omit<ImportDiagnostic, "id">,
) => {
  const id = DiagnosticIdSchema.make(`diag_${stableHash(input)}`);
  mutableRecord(catalog.diagnostics)[id] = {
    id,
    ...input,
  };
  return id;
};

const nativeBlob = (input: {
  source: Source;
  kind: string;
  pointer: string;
  value: unknown;
  summary?: string;
}): NativeBlob => ({
  sourceKind: sourceKindFromSource(input.source),
  kind: input.kind,
  pointer: input.pointer,
  encoding: "json",
  ...(input.summary ? { summary: input.summary } : {}),
  value: input.value,
});

const docsFrom = (input: {
  summary?: string | null;
  description?: string | null;
  externalDocsUrl?: string | null;
}): DocumentationBlock | undefined => {
  const summary = input.summary ?? undefined;
  const description = input.description ?? undefined;
  const externalDocsUrl = input.externalDocsUrl ?? undefined;

  if (!summary && !description && !externalDocsUrl) {
    return undefined;
  }

  return {
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
    ...(externalDocsUrl ? { externalDocsUrl } : {}),
  };
};

const createJsonSchemaImporter = (input: {
  catalog: CatalogV1;
  source: Source;
  resourceId: ReturnType<typeof ResourceIdSchema.make>;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
}) : JsonSchemaImporter => {
  const cache = new Map<string, ReturnType<typeof ShapeSymbolIdSchema.make>>();
  const structuralCache = new Map<string, ReturnType<typeof ShapeSymbolIdSchema.make>>();
  const dedupedShapeIds = new Map<ReturnType<typeof ShapeSymbolIdSchema.make>, ReturnType<typeof ShapeSymbolIdSchema.make>>();
  const activeShapeIds: ReturnType<typeof ShapeSymbolIdSchema.make>[] = [];
  const recursiveShapeIds = new Set<ReturnType<typeof ShapeSymbolIdSchema.make>>();

  const resolvePointer = (root: unknown, pointer: string): unknown => {
    if (pointer === "#" || pointer.length === 0) {
      return root;
    }

    const segments = pointer
      .replace(/^#\//, "")
      .split("/")
      .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
    let current: unknown = root;
    for (const segment of segments) {
      if (Array.isArray(current)) {
        const index = Number(segment);
        current = Number.isInteger(index) ? current[index] : undefined;
        continue;
      }

      current = asObject(current)[segment];
    }

    return current;
  };

  const importSchema = (schema: unknown, key: string, rootSchema?: unknown): ReturnType<typeof ShapeSymbolIdSchema.make> => {
    const stableKey = `${input.resourceId}:${key}`;
    const cached = cache.get(stableKey);
    if (cached) {
      const cycleIndex = activeShapeIds.indexOf(cached);
      if (cycleIndex !== -1) {
        for (const activeShapeId of activeShapeIds.slice(cycleIndex)) {
          recursiveShapeIds.add(activeShapeId);
        }
      }
      return cached;
    }

    const shapeId = ShapeSymbolIdSchema.make(`shape_${stableHash({ resourceId: input.resourceId, key })}`);
    cache.set(stableKey, shapeId);
    activeShapeIds.push(shapeId);

    try {

    const objectSchema = asObject(schema);
    const title = asString(objectSchema.title) ?? undefined;
    const docs = docsFrom({
      description: asString(objectSchema.description),
    });
    const deprecated = asBoolean(objectSchema.deprecated) ?? undefined;

    const register = (node: ShapeNode, extras: {
      native?: NativeBlob[];
      diagnosticIds?: ReturnType<typeof DiagnosticIdSchema.make>[];
    } = {}): ReturnType<typeof ShapeSymbolIdSchema.make> => {
      const signature = stableStringify(node);
      const recursive = recursiveShapeIds.has(shapeId);
      const existingShapeId = recursive ? undefined : structuralCache.get(signature);

      if (existingShapeId) {
        const existingShape = input.catalog.symbols[existingShapeId];
        if (existingShape?.kind === "shape") {
          if (existingShape.title === undefined && title) {
            mutableRecord(input.catalog.symbols)[existingShapeId] = {
              ...existingShape,
              title,
            } satisfies ShapeSymbol;
          }
          if (existingShape.docs === undefined && docs) {
            mutableRecord(input.catalog.symbols)[existingShapeId] = {
              ...(mutableRecord(input.catalog.symbols)[existingShapeId] as ShapeSymbol),
              docs,
            } satisfies ShapeSymbol;
          }
          if (existingShape.deprecated === undefined && deprecated !== undefined) {
            mutableRecord(input.catalog.symbols)[existingShapeId] = {
              ...(mutableRecord(input.catalog.symbols)[existingShapeId] as ShapeSymbol),
              deprecated,
            } satisfies ShapeSymbol;
          }
        }
        dedupedShapeIds.set(shapeId, existingShapeId);
        cache.set(stableKey, existingShapeId);
        return existingShapeId;
      }

      mutableRecord(input.catalog.symbols)[shapeId] = {
        id: shapeId,
        kind: "shape",
        resourceId: input.resourceId,
        ...(title ? { title } : {}),
        ...(docs ? { docs } : {}),
        ...(deprecated !== undefined ? { deprecated } : {}),
        node,
        synthetic: false,
        provenance: provenanceFor(input.documentId, key),
        ...(extras.diagnosticIds && extras.diagnosticIds.length > 0
          ? { diagnosticIds: extras.diagnosticIds }
          : {}),
        ...(extras.native && extras.native.length > 0 ? { native: extras.native } : {}),
      } satisfies ShapeSymbol;

      if (!recursive) {
        structuralCache.set(signature, shapeId);
      }

      return shapeId;
    };

    if (typeof schema === "boolean") {
      return register({
        type: "unknown",
        reason: schema ? "schema_true" : "schema_false",
      });
    }

    const ref = asString(objectSchema.$ref);
    if (ref !== null) {
      const resolved =
        ref.startsWith("#")
          ? resolvePointer(rootSchema ?? schema, ref)
          : undefined;

      if (resolved === undefined) {
        const diagnosticId = addDiagnostic(input.catalog, {
          level: "warning",
          code: "unresolved_ref",
          message: `Unresolved JSON schema ref ${ref}`,
          provenance: provenanceFor(input.documentId, key),
          relatedSymbolIds: [shapeId],
        });
        register(
          {
            type: "unknown",
            reason: `unresolved_ref:${ref}`,
          },
          {
            diagnosticIds: [diagnosticId],
          },
        );
        return cache.get(stableKey)!;
      }

      const target = importSchema(resolved, ref, rootSchema ?? schema);
      return register({
        type: "ref",
        target,
      });
    }

    const enumValues = asArray(objectSchema.enum);
    if (enumValues.length === 1) {
      return register({
        type: "const",
        value: enumValues[0],
      });
    }

    if (enumValues.length > 1) {
      return register({
        type: "enum",
        values: enumValues,
      });
    }

    if ("const" in objectSchema) {
      return register({
        type: "const",
        value: objectSchema.const,
      });
    }

    const anyOf = asArray(objectSchema.anyOf);
    if (anyOf.length > 0) {
      return register({
        type: "anyOf",
        items: anyOf.map((entry, index) => importSchema(entry, `${key}/anyOf/${index}`, rootSchema ?? schema)),
      });
    }

    const allOf = asArray(objectSchema.allOf);
    if (allOf.length > 0) {
      return register({
        type: "allOf",
        items: allOf.map((entry, index) => importSchema(entry, `${key}/allOf/${index}`, rootSchema ?? schema)),
      });
    }

    const oneOf = asArray(objectSchema.oneOf);
    if (oneOf.length > 0) {
      return register({
        type: "oneOf",
        items: oneOf.map((entry, index) => importSchema(entry, `${key}/oneOf/${index}`, rootSchema ?? schema)),
      });
    }

    if ("if" in objectSchema || "then" in objectSchema || "else" in objectSchema) {
      return register({
        type: "conditional",
        ifShapeId: importSchema(objectSchema.if ?? {}, `${key}/if`, rootSchema ?? schema),
        thenShapeId: importSchema(objectSchema.then ?? {}, `${key}/then`, rootSchema ?? schema),
        ...(objectSchema.else !== undefined
          ? {
              elseShapeId: importSchema(objectSchema.else, `${key}/else`, rootSchema ?? schema),
            }
          : {}),
      });
    }

    if ("not" in objectSchema) {
      return register({
        type: "not",
        itemShapeId: importSchema(objectSchema.not, `${key}/not`, rootSchema ?? schema),
      });
    }

    const declaredType = objectSchema.type;
    const typeArray = Array.isArray(declaredType)
      ? declaredType.flatMap((entry) => {
          const value = asString(entry);
          return value === null ? [] : [value];
        })
      : [];
    const nullable = asBoolean(objectSchema.nullable) === true || typeArray.includes("null");
    const effectiveType = Array.isArray(declaredType)
      ? typeArray.find((entry) => entry !== "null") ?? null
      : asString(declaredType);

    const registerNullable = (itemShapeId: ReturnType<typeof ShapeSymbolIdSchema.make>) => {
      register({
        type: "nullable",
        itemShapeId,
      });
      return shapeId;
    };

    const constraints: Record<string, unknown> = {};
    for (const constraintKey of [
      "format",
      "minLength",
      "maxLength",
      "pattern",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "default",
      "examples",
    ]) {
      if (objectSchema[constraintKey] !== undefined) {
        constraints[constraintKey] = objectSchema[constraintKey];
      }
    }

    if (
      effectiveType === "object"
      || "properties" in objectSchema
      || "additionalProperties" in objectSchema
      || "patternProperties" in objectSchema
    ) {
      const fields = Object.fromEntries(
        Object.entries(asObject(objectSchema.properties)).map(([fieldName, fieldSchema]) => [
          fieldName,
          {
            shapeId: importSchema(
              fieldSchema,
              `${key}/properties/${fieldName}`,
              rootSchema ?? schema,
            ),
            ...(docsFrom({
              description: asString(asObject(fieldSchema).description),
            })
              ? {
                  docs: docsFrom({
                    description: asString(asObject(fieldSchema).description),
                  })!,
                }
              : {}),
          },
        ]),
      );

      const patternProperties = Object.fromEntries(
        Object.entries(asObject(objectSchema.patternProperties)).map(([pattern, value]) => [
          pattern,
          importSchema(value, `${key}/patternProperties/${pattern}`, rootSchema ?? schema),
        ]),
      );

      const additionalPropertiesValue = objectSchema.additionalProperties;
      const additionalProperties =
        typeof additionalPropertiesValue === "boolean"
          ? additionalPropertiesValue
          : additionalPropertiesValue !== undefined
            ? importSchema(additionalPropertiesValue, `${key}/additionalProperties`, rootSchema ?? schema)
            : undefined;

      const objectNode: ShapeNode = {
        type: "object",
        fields,
        ...(asStringArray(objectSchema.required).length > 0
          ? { required: asStringArray(objectSchema.required) }
          : {}),
        ...(additionalProperties !== undefined ? { additionalProperties } : {}),
        ...(Object.keys(patternProperties).length > 0 ? { patternProperties } : {}),
      };

      if (nullable) {
        const innerId = importSchema(
          {
            ...objectSchema,
            nullable: false,
            type: "object",
          },
          `${key}:nonnull`,
          rootSchema ?? schema,
        );
        return registerNullable(innerId);
      }

      return register(objectNode);
    }

    if (effectiveType === "array" || "items" in objectSchema || "prefixItems" in objectSchema) {
      if (Array.isArray(objectSchema.prefixItems) && objectSchema.prefixItems.length > 0) {
        const tupleNode: ShapeNode = {
          type: "tuple",
          itemShapeIds: objectSchema.prefixItems.map((entry, index) =>
            importSchema(entry, `${key}/prefixItems/${index}`, rootSchema ?? schema)
          ),
          ...(objectSchema.items !== undefined
            ? {
                additionalItems:
                  typeof objectSchema.items === "boolean"
                    ? objectSchema.items
                    : importSchema(objectSchema.items, `${key}/items`, rootSchema ?? schema),
              }
            : {}),
        };

        if (nullable) {
          const innerId = importSchema(
            {
              ...objectSchema,
              nullable: false,
              type: "array",
            },
            `${key}:nonnull`,
            rootSchema ?? schema,
          );
          return registerNullable(innerId);
        }

        return register(tupleNode);
      }

      const items = objectSchema.items ?? {};
      const arrayNode: ShapeNode = {
        type: "array",
        itemShapeId: importSchema(items, `${key}/items`, rootSchema ?? schema),
        ...(asNumber(objectSchema.minItems) !== null ? { minItems: asNumber(objectSchema.minItems)! } : {}),
        ...(asNumber(objectSchema.maxItems) !== null ? { maxItems: asNumber(objectSchema.maxItems)! } : {}),
      };

      if (nullable) {
        const innerId = importSchema(
          {
            ...objectSchema,
            nullable: false,
            type: "array",
          },
          `${key}:nonnull`,
          rootSchema ?? schema,
        );
        return registerNullable(innerId);
      }

      return register(arrayNode);
    }

    if (
      effectiveType === "string"
      || effectiveType === "number"
      || effectiveType === "integer"
      || effectiveType === "boolean"
      || effectiveType === "null"
    ) {
      const scalar =
        effectiveType === "null"
          ? "null"
          : effectiveType === "integer"
            ? "integer"
            : effectiveType === "number"
              ? "number"
              : effectiveType === "boolean"
                ? "boolean"
                : asString(objectSchema.format) === "binary"
                  ? "bytes"
                  : "string";

      const scalarNode: ShapeNode = {
        type: "scalar",
        scalar,
        ...(asString(objectSchema.format) ? { format: asString(objectSchema.format)! } : {}),
        ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
      };

      if (nullable && scalar !== "null") {
        const innerId = importSchema(
          {
            ...objectSchema,
            nullable: false,
            type: effectiveType,
          },
          `${key}:nonnull`,
          rootSchema ?? schema,
        );
        return registerNullable(innerId);
      }

      return register(scalarNode);
    }

    return register({
      type: "unknown",
      reason: `unsupported_schema:${key}`,
    }, {
      native: [nativeBlob({
        source: input.source,
        kind: "json_schema",
        pointer: key,
        value: schema,
        summary: "Unsupported JSON schema preserved natively",
      })],
    });
    } finally {
      const poppedShapeId = activeShapeIds.pop();
      if (poppedShapeId !== shapeId) {
        throw new Error(`JSON schema importer stack mismatch for ${shapeId}`);
      }
    }
  };

  return {
    importSchema: (schema, key, rootSchema) => importSchema(schema, key, rootSchema ?? schema),
    finalize: () => {
      const rewriteDedupedShapeIds = (value: unknown): void => {
        if (typeof value === "string") {
          return;
        }
        if (!value || typeof value !== "object") {
          return;
        }
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index += 1) {
            const entry = value[index];
            if (typeof entry === "string" && dedupedShapeIds.has(entry as ReturnType<typeof ShapeSymbolIdSchema.make>)) {
              value[index] = dedupedShapeIds.get(entry as ReturnType<typeof ShapeSymbolIdSchema.make>)!;
            } else {
              rewriteDedupedShapeIds(entry);
            }
          }
          return;
        }

        for (const [entryKey, entryValue] of Object.entries(value)) {
          if (typeof entryValue === "string" && dedupedShapeIds.has(entryValue as ReturnType<typeof ShapeSymbolIdSchema.make>)) {
            (value as Record<string, unknown>)[entryKey] = dedupedShapeIds.get(entryValue as ReturnType<typeof ShapeSymbolIdSchema.make>)!;
          } else {
            rewriteDedupedShapeIds(entryValue);
          }
        }
      };

      rewriteDedupedShapeIds(input.catalog);
    },
  };
};

const exampleSymbolFromValue = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  pointer: string;
  name?: string;
  value: unknown;
  summary?: string;
  description?: string;
}): ReturnType<typeof ExampleSymbolIdSchema.make> => {
  const exampleId = ExampleSymbolIdSchema.make(`example_${stableHash({
    pointer: input.pointer,
    value: input.value,
  })}`);
  mutableRecord(input.catalog.symbols)[exampleId] = {
    id: exampleId,
    kind: "example",
    exampleKind: "value",
    ...(input.name ? { name: input.name } : {}),
    ...(docsFrom({
      summary: input.summary ?? null,
      description: input.description ?? null,
    })
      ? {
          docs: docsFrom({
            summary: input.summary ?? null,
            description: input.description ?? null,
          })!,
        }
      : {}),
    value: input.value,
    synthetic: false,
    provenance: provenanceFor(input.documentId, input.pointer),
  } satisfies ExampleSymbol;
  return exampleId;
};

const schemaFromField = (schema: unknown, fieldName: string): unknown => {
  const record = asObject(schema);
  const properties = asObject(record.properties);
  if (properties[fieldName] !== undefined) {
    return properties[fieldName];
  }
  return undefined;
};

const groupedSchemaForParameter = (schema: unknown, location: string, name: string): unknown => {
  const direct = schemaFromField(schema, name);
  if (direct !== undefined) {
    return direct;
  }

  const groupKey =
    location === "header"
      ? "headers"
      : location === "cookie"
        ? "cookies"
        : location;
  const groupSchema = schemaFromField(schema, groupKey);
  return groupSchema === undefined ? undefined : schemaFromField(groupSchema, name);
};

const requestBodySchemaFromInput = (schema: unknown): unknown =>
  schemaFromField(schema, "body") ?? schemaFromField(schema, "input");

const preferredResponseContentTypes = (
  mediaTypes: readonly string[] | undefined,
): string[] => {
  const candidates = mediaTypes && mediaTypes.length > 0
    ? [...mediaTypes]
    : ["application/json"];

  const preferred = [
    ...candidates.filter((mediaType) => mediaType === "application/json"),
    ...candidates.filter((mediaType) => mediaType !== "application/json" && mediaType.toLowerCase().includes("+json")),
    ...candidates.filter((mediaType) =>
      mediaType !== "application/json"
      && !mediaType.toLowerCase().includes("+json")
      && mediaType.toLowerCase().includes("json"),
    ),
    ...candidates,
  ];

  return [...new Set(preferred)];
};

const createServiceScope = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  defaults?: Scope["defaults"];
}) => {
  const scopeId = serviceScopeIdForSource(input.source);
  mutableRecord(input.catalog.scopes)[scopeId] = {
    id: scopeId,
    kind: "service",
    name: input.source.name,
    namespace: input.source.namespace ?? namespaceFromSourceName(input.source.name),
    docs: docsFrom({
      summary: input.source.name,
    }),
    ...(input.defaults ? { defaults: input.defaults } : {}),
    synthetic: false,
    provenance: provenanceFor(input.documentId, "#/service"),
  } satisfies Scope;
  return scopeId;
};

const openApiServerSpecs = (
  servers: OpenApiToolProviderData["servers"] | OpenApiToolProviderData["documentServers"] | undefined,
): NonNullable<NonNullable<Scope["defaults"]>["servers"]> | undefined => {
  if (!servers || servers.length === 0) {
    return undefined;
  }

  return servers.map((server) => ({
    url: server.url,
    ...(server.description ? { description: server.description } : {}),
    ...(server.variables ? { variables: server.variables } : {}),
  }));
};

const googleDiscoveryServerSpecs = (
  operation: GoogleDiscoveryCatalogOperationInput | undefined,
): NonNullable<NonNullable<Scope["defaults"]>["servers"]> | undefined => {
  const rootUrl = operation?.providerData.invocation.rootUrl;
  if (!rootUrl) {
    return undefined;
  }

  const servicePath = operation?.providerData.invocation.servicePath ?? "";
  return [{
    url: new URL(servicePath || "", rootUrl).toString(),
  }];
};

const createOperationScope = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  parentScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: OpenApiCatalogOperationInput;
  defaults: Scope["defaults"];
}) => {
  const scopeId = ScopeIdSchema.make(`scope_${stableHash({
    sourceId: input.source.id,
    toolId: input.operation.providerData.toolId,
    kind: "operation",
  })}`);

  mutableRecord(input.catalog.scopes)[scopeId] = {
    id: scopeId,
    kind: "operation",
    parentId: input.parentScopeId,
    name: input.operation.title ?? input.operation.providerData.toolId,
    docs: docsFrom({
      summary: input.operation.title ?? input.operation.providerData.toolId,
      description: input.operation.description ?? undefined,
    }),
    defaults: input.defaults,
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/openapi/${input.operation.providerData.toolId}/scope`),
  } satisfies Scope;

  return scopeId;
};

const responseSetFromSingleResponse = (input: {
  catalog: CatalogV1;
  responseId: ReturnType<typeof ResponseSymbolIdSchema.make>;
  provenance: ProvenanceRef[];
  traits?: ResponseSet["variants"][number]["traits"];
}) => {
  const responseSetId = ResponseSetIdSchema.make(`response_set_${stableHash({
    responseId: input.responseId,
    traits: input.traits,
  })}`);
  mutableRecord(input.catalog.responseSets)[responseSetId] = {
    id: responseSetId,
    variants: [{
      match: {
        kind: "range",
        value: "2XX",
      },
      responseId: input.responseId,
      ...(input.traits && input.traits.length > 0 ? { traits: input.traits } : {}),
    }],
    synthetic: false,
    provenance: input.provenance,
  } satisfies ResponseSet;
  return responseSetId;
};

const responseSetFromVariants = (input: {
  catalog: CatalogV1;
  variants: ResponseSet["variants"];
  provenance: ProvenanceRef[];
}) => {
  const responseSetId = ResponseSetIdSchema.make(`response_set_${stableHash({
    variants: input.variants.map((variant) => ({
      match: variant.match,
      responseId: variant.responseId,
      traits: variant.traits,
    })),
  })}`);
  mutableRecord(input.catalog.responseSets)[responseSetId] = {
    id: responseSetId,
    variants: input.variants,
    synthetic: false,
    provenance: input.provenance,
  } satisfies ResponseSet;
  return responseSetId;
};

const statusMatchFromHttpStatusCode = (
  statusCode: string,
): ResponseSet["variants"][number]["match"] => {
  const normalized = statusCode.trim().toUpperCase();

  if (/^\d{3}$/.test(normalized)) {
    return {
      kind: "exact",
      status: Number(normalized),
    };
  }

  if (/^[1-5]XX$/.test(normalized)) {
    return {
      kind: "range",
      value: normalized as "1XX" | "2XX" | "3XX" | "4XX" | "5XX",
    };
  }

  return {
    kind: "default",
  };
};

const ensureOpenApiSecuritySchemeSymbol = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  schemeName: string;
  scheme?: NonNullable<OpenApiToolProviderData["securitySchemes"]>[number];
}) => {
  const schemeId = SecuritySchemeSymbolIdSchema.make(`security_${stableHash({
    sourceId: input.source.id,
    provider: "openapi",
    schemeName: input.schemeName,
  })}`);

  if (input.catalog.symbols[schemeId]) {
    return schemeId;
  }

  const scheme = input.scheme;
  const httpScheme = scheme?.scheme?.toLowerCase();
  const schemeType =
    scheme?.schemeType === "apiKey"
      ? "apiKey"
      : scheme?.schemeType === "oauth2"
        ? "oauth2"
        : scheme?.schemeType === "http" && httpScheme === "basic"
          ? "basic"
          : scheme?.schemeType === "http" && httpScheme === "bearer"
            ? "bearer"
            : scheme?.schemeType === "openIdConnect"
              ? "custom"
              : scheme?.schemeType === "http"
                ? "http"
                : "custom";

  const oauthFlows = Object.fromEntries(
    Object.entries(scheme?.flows ?? {}).map(([flowName, flow]) => [flowName, flow]),
  );
  const oauthScopes = Object.fromEntries(
    Object.entries(scheme?.flows ?? {}).flatMap(([, flow]) =>
      Object.entries(flow.scopes ?? {}),
    ),
  );
  const description = scheme?.description
    ?? (scheme?.openIdConnectUrl
      ? `OpenID Connect: ${scheme.openIdConnectUrl}`
      : null);

  mutableRecord(input.catalog.symbols)[schemeId] = {
    id: schemeId,
    kind: "securityScheme",
    schemeType,
    ...(docsFrom({
      summary: input.schemeName,
      description,
    })
      ? {
          docs: docsFrom({
            summary: input.schemeName,
            description,
          })!,
        }
      : {}),
    ...((scheme?.placementIn || scheme?.placementName)
      ? {
          placement: {
            ...(scheme?.placementIn ? { in: scheme.placementIn } : {}),
            ...(scheme?.placementName ? { name: scheme.placementName } : {}),
          },
        }
      : {}),
    ...(schemeType === "apiKey" && scheme?.placementIn && scheme?.placementName
      ? {
          apiKey: {
            in: scheme.placementIn,
            name: scheme.placementName,
          },
        }
      : {}),
    ...((schemeType === "basic" || schemeType === "bearer" || schemeType === "http") && scheme?.scheme
      ? {
          http: {
            scheme: scheme.scheme,
            ...(scheme.bearerFormat ? { bearerFormat: scheme.bearerFormat } : {}),
          },
        }
      : {}),
    ...(schemeType === "oauth2"
      ? {
          oauth: {
            ...(Object.keys(oauthFlows).length > 0 ? { flows: oauthFlows } : {}),
            ...(Object.keys(oauthScopes).length > 0 ? { scopes: oauthScopes } : {}),
          },
        }
      : {}),
    ...(schemeType === "custom"
      ? {
          custom: {},
        }
      : {}),
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/openapi/securitySchemes/${input.schemeName}`,
    ),
  } satisfies SecuritySchemeSymbol;

  return schemeId;
};

const openApiAuthRequirementToIr = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  authRequirement: OpenApiToolProviderData["authRequirement"] | undefined;
  schemesByName: ReadonlyMap<string, NonNullable<OpenApiToolProviderData["securitySchemes"]>[number]>;
}): AuthRequirement => {
  const requirement = input.authRequirement;
  if (!requirement) {
    return {
      kind: "none",
    };
  }

  switch (requirement.kind) {
    case "none":
      return {
        kind: "none",
      };
    case "scheme": {
      const schemeId = ensureOpenApiSecuritySchemeSymbol({
        catalog: input.catalog,
        source: input.source,
        documentId: input.documentId,
        schemeName: requirement.schemeName,
        scheme: input.schemesByName.get(requirement.schemeName),
      });

      return {
        kind: "scheme",
        schemeId,
        ...(requirement.scopes && requirement.scopes.length > 0
          ? { scopes: [...requirement.scopes] }
          : {}),
      };
    }
    case "allOf":
    case "anyOf":
      return {
        kind: requirement.kind,
        items: requirement.items.map((item) =>
          openApiAuthRequirementToIr({
            catalog: input.catalog,
            source: input.source,
            documentId: input.documentId,
            authRequirement: item,
            schemesByName: input.schemesByName,
          })),
      };
  }
};

const contentSpecsFromOpenApiContents = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  importer: JsonSchemaImporter;
  rootSchema?: unknown;
  contents:
    | ReadonlyArray<NonNullable<NonNullable<OpenApiToolProviderData["responses"]>[number]["contents"]>[number]>
    | ReadonlyArray<NonNullable<NonNullable<OpenApiToolProviderData["invocation"]["requestBody"]>["contents"]>[number]>
    | ReadonlyArray<NonNullable<NonNullable<OpenApiToolProviderData["invocation"]["parameters"][number]["content"]>[number]>>;
  pointerBase: string;
}) =>
  input.contents.map((content, contentIndex) => {
    const exampleIds = (content.examples ?? []).map((example, exampleIndex) =>
      exampleSymbolFromValue({
        catalog: input.catalog,
        source: input.source,
        documentId: input.documentId,
        pointer: `${input.pointerBase}/content/${contentIndex}/example/${exampleIndex}`,
        name: example.label,
        summary: example.label,
        value: JSON.parse(example.valueJson) as unknown,
      })
    );

    return {
      mediaType: content.mediaType,
      ...(content.schema !== undefined
        ? {
            shapeId: input.importer.importSchema(
              content.schema,
              `${input.pointerBase}/content/${contentIndex}`,
              input.rootSchema,
            ),
          }
        : {}),
      ...(exampleIds.length > 0 ? { exampleIds } : {}),
    } satisfies ContentSpec;
  });

const createOpenApiHeaderSymbol = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  importer: JsonSchemaImporter;
  rootSchema?: unknown;
  pointer: string;
  idSeed: Record<string, unknown>;
  header: NonNullable<NonNullable<OpenApiToolProviderData["responses"]>[number]["headers"]>[number];
}) => {
  const headerId = HeaderSymbolIdSchema.make(`header_${stableHash(input.idSeed)}`);
  const exampleIds = (input.header.examples ?? []).map((example, index) =>
    exampleSymbolFromValue({
      catalog: input.catalog,
      source: input.source,
      documentId: input.documentId,
      pointer: `${input.pointer}/example/${index}`,
      name: example.label,
      summary: example.label,
      value: JSON.parse(example.valueJson) as unknown,
    })
  );
  const contents = input.header.content
    ? contentSpecsFromOpenApiContents({
        catalog: input.catalog,
        source: input.source,
        documentId: input.documentId,
        importer: input.importer,
        rootSchema: input.rootSchema,
        contents: input.header.content,
        pointerBase: input.pointer,
      })
    : undefined;

  mutableRecord(input.catalog.symbols)[headerId] = {
    id: headerId,
    kind: "header",
    name: input.header.name,
    ...(docsFrom({
      description: input.header.description,
    })
      ? {
          docs: docsFrom({
            description: input.header.description,
          })!,
        }
      : {}),
    ...(typeof input.header.deprecated === "boolean" ? { deprecated: input.header.deprecated } : {}),
    ...(input.header.schema !== undefined
      ? {
          schemaShapeId: input.importer.importSchema(
            input.header.schema,
            input.pointer,
            input.rootSchema,
          ),
        }
      : {}),
    ...(contents && contents.length > 0 ? { content: contents } : {}),
    ...(exampleIds.length > 0 ? { exampleIds } : {}),
    ...(input.header.style ? { style: input.header.style } : {}),
    ...(typeof input.header.explode === "boolean" ? { explode: input.header.explode } : {}),
    synthetic: false,
    provenance: provenanceFor(input.documentId, input.pointer),
  };

  return headerId;
};

const createHttpCapabilityFromOpenApi = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  serviceScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: OpenApiCatalogOperationInput;
  importer: JsonSchemaImporter;
  rootSchema?: unknown;
}) => {
  const toolPath = toolPathSegments(input.source, input.operation.providerData.toolId);
  const capabilityId = CapabilityIdSchema.make(`cap_${stableHash({
    sourceId: input.source.id,
    toolId: input.operation.providerData.toolId,
  })}`);
  const executableId = ExecutableIdSchema.make(`exec_${stableHash({
    sourceId: input.source.id,
    toolId: input.operation.providerData.toolId,
    protocol: "http",
  })}`);
  const inputSchema = input.operation.inputSchema ?? {};
  const outputSchema = input.operation.outputSchema ?? {};
  const exampleIds: Array<ReturnType<typeof ExampleSymbolIdSchema.make>> = [];
  const schemesByName = new Map(
    (input.operation.providerData.securitySchemes ?? []).map((scheme) => [scheme.schemeName, scheme] as const),
  );

  const parameterIds = input.operation.providerData.invocation.parameters.map((parameter) => {
    const parameterId = ParameterSymbolIdSchema.make(`param_${stableHash({
      capabilityId,
      location: parameter.location,
      name: parameter.name,
    })}`);
    const parameterSchema = groupedSchemaForParameter(inputSchema, parameter.location, parameter.name);
    const matchingDocs = input.operation.providerData.documentation?.parameters.find((candidate) =>
      candidate.name === parameter.name && candidate.location === parameter.location
    );
    const parameterExampleIds = (matchingDocs?.examples ?? []).map((example, index) => {
      const parsed = JSON.parse(example.valueJson) as unknown;
      return exampleSymbolFromValue({
        catalog: input.catalog,
        source: input.source,
        documentId: input.documentId,
        pointer: `#/openapi/${input.operation.providerData.toolId}/parameter/${parameter.location}/${parameter.name}/example/${index}`,
        name: example.label,
        summary: example.label,
        value: parsed,
      });
    });
    exampleIds.push(...parameterExampleIds);
    const parameterContent = parameter.content
      ? contentSpecsFromOpenApiContents({
          catalog: input.catalog,
          source: input.source,
          documentId: input.documentId,
          importer: input.importer,
          rootSchema: input.rootSchema,
          contents: parameter.content,
          pointerBase: `#/openapi/${input.operation.providerData.toolId}/parameter/${parameter.location}/${parameter.name}`,
        })
      : undefined;
    mutableRecord(input.catalog.symbols)[parameterId] = {
      id: parameterId,
      kind: "parameter",
      name: parameter.name,
      location: parameter.location,
      required: parameter.required,
      ...(docsFrom({
        description: matchingDocs?.description ?? null,
      })
        ? {
            docs: docsFrom({
              description: matchingDocs?.description ?? null,
            })!,
        }
      : {}),
      ...(parameterSchema !== undefined && (!parameterContent || parameterContent.length === 0)
        ? {
            schemaShapeId: input.importer.importSchema(
              parameterSchema,
              `#/openapi/${input.operation.providerData.toolId}/parameter/${parameter.location}/${parameter.name}`,
              input.rootSchema,
            ),
          }
        : {}),
      ...(parameterContent && parameterContent.length > 0 ? { content: parameterContent } : {}),
      ...(parameterExampleIds.length > 0 ? { exampleIds: parameterExampleIds } : {}),
      ...(parameter.style ? { style: parameter.style } : {}),
      ...(typeof parameter.explode === "boolean" ? { explode: parameter.explode } : {}),
      ...(typeof parameter.allowReserved === "boolean" ? { allowReserved: parameter.allowReserved } : {}),
      synthetic: false,
      provenance: provenanceFor(
        input.documentId,
        `#/openapi/${input.operation.providerData.toolId}/parameter/${parameter.location}/${parameter.name}`,
      ),
    } satisfies ParameterSymbol;
    return parameterId;
  });

  const requestBodyId = input.operation.providerData.invocation.requestBody
    ? RequestBodySymbolIdSchema.make(`request_body_${stableHash({ capabilityId })}`)
    : undefined;

  if (requestBodyId) {
    const requestBodySchema = requestBodySchemaFromInput(inputSchema);
    const requestBodyContents = input.operation.providerData.invocation.requestBody?.contents
      ? contentSpecsFromOpenApiContents({
          catalog: input.catalog,
          source: input.source,
          documentId: input.documentId,
          importer: input.importer,
          rootSchema: input.rootSchema,
          contents: input.operation.providerData.invocation.requestBody.contents,
          pointerBase: `#/openapi/${input.operation.providerData.toolId}/requestBody`,
        })
      : undefined;
    const requestBodyExampleIds =
      requestBodyContents?.flatMap((content) => content.exampleIds ?? [])
      ?? (input.operation.providerData.documentation?.requestBody?.examples ?? []).map(
        (example, index) =>
          exampleSymbolFromValue({
            catalog: input.catalog,
            source: input.source,
            documentId: input.documentId,
            pointer: `#/openapi/${input.operation.providerData.toolId}/requestBody/example/${index}`,
            name: example.label,
            summary: example.label,
            value: JSON.parse(example.valueJson) as unknown,
          }),
      );
    exampleIds.push(...requestBodyExampleIds);
    const contents: ContentSpec[] =
      requestBodyContents && requestBodyContents.length > 0
        ? requestBodyContents
        : preferredResponseContentTypes(
            input.operation.providerData.invocation.requestBody?.contentTypes,
          ).map((mediaType) => ({
            mediaType,
            ...(requestBodySchema !== undefined
              ? {
                  shapeId: input.importer.importSchema(
                    requestBodySchema,
                    `#/openapi/${input.operation.providerData.toolId}/requestBody`,
                    input.rootSchema,
                  ),
                }
              : {}),
            ...(requestBodyExampleIds.length > 0 ? { exampleIds: requestBodyExampleIds } : {}),
          }));

    mutableRecord(input.catalog.symbols)[requestBodyId] = {
      id: requestBodyId,
      kind: "requestBody",
      ...(docsFrom({
        description: input.operation.providerData.documentation?.requestBody?.description ?? null,
      })
        ? {
            docs: docsFrom({
              description: input.operation.providerData.documentation?.requestBody?.description ?? null,
            })!,
          }
        : {}),
      required: input.operation.providerData.invocation.requestBody?.required ?? false,
      contents,
      synthetic: false,
      provenance: provenanceFor(input.documentId, `#/openapi/${input.operation.providerData.toolId}/requestBody`),
    };
  }

  const openApiResponseVariants = input.operation.providerData.responses ?? [];
  const responseSetId =
    openApiResponseVariants.length > 0
      ? responseSetFromVariants({
          catalog: input.catalog,
          variants: openApiResponseVariants.map((response, responseIndex) => {
            const responseId = ResponseSymbolIdSchema.make(`response_${stableHash({
              capabilityId,
              statusCode: response.statusCode,
              responseIndex,
            })}`);
            const responseExampleIds = (response.examples ?? []).map((example, index) =>
              exampleSymbolFromValue({
                catalog: input.catalog,
                source: input.source,
                documentId: input.documentId,
                pointer: `#/openapi/${input.operation.providerData.toolId}/responses/${response.statusCode}/example/${index}`,
                name: example.label,
                summary: example.label,
                value: JSON.parse(example.valueJson) as unknown,
              })
            );
            exampleIds.push(...responseExampleIds);

            const contents =
              response.contents && response.contents.length > 0
                ? contentSpecsFromOpenApiContents({
                    catalog: input.catalog,
                    source: input.source,
                    documentId: input.documentId,
                    importer: input.importer,
                    rootSchema: input.rootSchema,
                    contents: response.contents,
                    pointerBase: `#/openapi/${input.operation.providerData.toolId}/responses/${response.statusCode}`,
                  })
                : (() => {
                    const responseShapeId =
                      response.schema !== undefined
                        ? input.importer.importSchema(
                            response.schema,
                            `#/openapi/${input.operation.providerData.toolId}/responses/${response.statusCode}`,
                            input.rootSchema,
                          )
                        : undefined;
                    const preferredContentTypes = preferredResponseContentTypes(response.contentTypes);

                    return preferredContentTypes.length > 0
                      ? preferredContentTypes.map((mediaType, contentIndex) => ({
                          mediaType,
                          ...(responseShapeId !== undefined && contentIndex === 0
                            ? { shapeId: responseShapeId }
                            : {}),
                          ...(responseExampleIds.length > 0 && contentIndex === 0
                            ? { exampleIds: responseExampleIds }
                            : {}),
                        }))
                      : undefined;
                  })();
            const headerIds = (response.headers ?? []).map((header, headerIndex) =>
              createOpenApiHeaderSymbol({
                catalog: input.catalog,
                source: input.source,
                documentId: input.documentId,
                importer: input.importer,
                rootSchema: input.rootSchema,
                pointer: `#/openapi/${input.operation.providerData.toolId}/responses/${response.statusCode}/headers/${header.name}`,
                idSeed: {
                  capabilityId,
                  responseId,
                  headerIndex,
                  headerName: header.name,
                },
                header,
              })
            );

            mutableRecord(input.catalog.symbols)[responseId] = {
              id: responseId,
              kind: "response",
              ...(docsFrom({
                description:
                  response.description
                  ?? (responseIndex === 0 ? input.operation.description : null),
              })
                ? {
                    docs: docsFrom({
                      description:
                        response.description
                        ?? (responseIndex === 0 ? input.operation.description : null),
                    })!,
                  }
                : {}),
              ...(headerIds.length > 0 ? { headerIds } : {}),
              ...(contents && contents.length > 0 ? { contents } : {}),
              synthetic: false,
              provenance: provenanceFor(
                input.documentId,
                `#/openapi/${input.operation.providerData.toolId}/responses/${response.statusCode}`,
              ),
            } satisfies ResponseSymbol;

            return {
              match: statusMatchFromHttpStatusCode(response.statusCode),
              responseId,
            } satisfies ResponseSet["variants"][number];
          }),
          provenance: provenanceFor(input.documentId, `#/openapi/${input.operation.providerData.toolId}/responseSet`),
        })
      : (() => {
          const responseId = ResponseSymbolIdSchema.make(`response_${stableHash({ capabilityId })}`);
          const responseExampleIds = (input.operation.providerData.documentation?.response?.examples ?? []).map((example, index) =>
            exampleSymbolFromValue({
              catalog: input.catalog,
              source: input.source,
              documentId: input.documentId,
              pointer: `#/openapi/${input.operation.providerData.toolId}/response/example/${index}`,
              name: example.label,
              summary: example.label,
              value: JSON.parse(example.valueJson) as unknown,
            })
          );
          exampleIds.push(...responseExampleIds);
          mutableRecord(input.catalog.symbols)[responseId] = {
            id: responseId,
            kind: "response",
            ...(docsFrom({
              description:
                input.operation.providerData.documentation?.response?.description
                ?? input.operation.description,
            })
              ? {
                  docs: docsFrom({
                    description:
                      input.operation.providerData.documentation?.response?.description
                      ?? input.operation.description,
                  })!,
                }
              : {}),
            contents: [{
              mediaType: preferredResponseContentTypes(input.operation.providerData.documentation?.response?.contentTypes)[0] ?? "application/json",
              ...(input.operation.outputSchema !== undefined
                ? {
                    shapeId: input.importer.importSchema(
                      outputSchema,
                      `#/openapi/${input.operation.providerData.toolId}/response`,
                    ),
                  }
                : {}),
              ...(responseExampleIds.length > 0 ? { exampleIds: responseExampleIds } : {}),
            }],
            synthetic: false,
            provenance: provenanceFor(input.documentId, `#/openapi/${input.operation.providerData.toolId}/response`),
          } satisfies ResponseSymbol;

          return responseSetFromSingleResponse({
            catalog: input.catalog,
            responseId,
            provenance: provenanceFor(input.documentId, `#/openapi/${input.operation.providerData.toolId}/responseSet`),
          });
        })();

  const executable: HttpExecutable = {
    id: executableId,
    protocol: "http",
    capabilityId,
    scopeId: (() => {
      const operationServers = openApiServerSpecs(input.operation.providerData.servers);
      if (!operationServers || operationServers.length === 0) {
        return input.serviceScopeId;
      }

      return createOperationScope({
        catalog: input.catalog,
        source: input.source,
        documentId: input.documentId,
        parentScopeId: input.serviceScopeId,
        operation: input.operation,
        defaults: {
          servers: operationServers,
        },
      });
    })(),
    method: input.operation.providerData.invocation.method.toUpperCase(),
    pathTemplate: input.operation.providerData.invocation.pathTemplate,
    pathParameterIds: parameterIds.filter((parameterId) => {
      const parameter = input.catalog.symbols[parameterId] as ParameterSymbol | undefined;
      return parameter?.location === "path";
    }),
    queryParameterIds: parameterIds.filter((parameterId) => {
      const parameter = input.catalog.symbols[parameterId] as ParameterSymbol | undefined;
      return parameter?.location === "query";
    }),
    headerParameterIds: parameterIds.filter((parameterId) => {
      const parameter = input.catalog.symbols[parameterId] as ParameterSymbol | undefined;
      return parameter?.location === "header";
    }),
    cookieParameterIds: parameterIds.filter((parameterId) => {
      const parameter = input.catalog.symbols[parameterId] as ParameterSymbol | undefined;
      return parameter?.location === "cookie";
    }),
    ...(requestBodyId ? { requestBodyId } : {}),
    responseSetId,
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/openapi/${input.operation.providerData.toolId}/executable`),
  };
  mutableRecord(input.catalog.executables)[executableId] = executable;

  const effect = input.operation.effect;
  const auth = openApiAuthRequirementToIr({
    catalog: input.catalog,
    source: input.source,
    documentId: input.documentId,
    authRequirement: input.operation.providerData.authRequirement,
    schemesByName,
  });
  mutableRecord(input.catalog.capabilities)[capabilityId] = {
    id: capabilityId,
    serviceScopeId: input.serviceScopeId,
    surface: {
      toolPath,
      ...(input.operation.title ? { title: input.operation.title } : {}),
      ...(input.operation.description ? { summary: input.operation.description } : {}),
      ...(input.operation.providerData.tags.length > 0 ? { tags: input.operation.providerData.tags } : {}),
    },
    semantics: {
      effect,
      safe: effect === "read",
      idempotent: effect === "read" || effect === "delete",
      destructive: effect === "delete",
    },
    auth,
    interaction: interactionForEffect(effect),
    executableIds: [executableId],
    ...(exampleIds.length > 0 ? { exampleIds } : {}),
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/openapi/${input.operation.providerData.toolId}/capability`),
  } satisfies Capability;
};

const createHttpCapabilityFromGoogleDiscovery = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  serviceScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: GoogleDiscoveryCatalogOperationInput;
  importer: JsonSchemaImporter;
}) => {
  const toolPath = toolPathSegments(input.source, input.operation.providerData.toolId);
  const capabilityId = CapabilityIdSchema.make(`cap_${stableHash({
    sourceId: input.source.id,
    toolId: input.operation.providerData.toolId,
  })}`);
  const executableId = ExecutableIdSchema.make(`exec_${stableHash({
    sourceId: input.source.id,
    toolId: input.operation.providerData.toolId,
    protocol: "http",
  })}`);
  const inputSchema = input.operation.inputSchema ?? {};
  const outputSchema = input.operation.outputSchema ?? {};

  const authSchemeId = input.operation.providerData.invocation.scopes.length > 0
    ? SecuritySchemeSymbolIdSchema.make(`security_${stableHash({
        sourceId: input.source.id,
        scopes: input.operation.providerData.invocation.scopes,
      })}`)
    : undefined;

  if (authSchemeId && !input.catalog.symbols[authSchemeId]) {
    const scopeDescriptions = Object.fromEntries(
      input.operation.providerData.invocation.scopes.map((scope) => [
        scope,
        input.operation.providerData.invocation.scopeDescriptions?.[scope] ?? scope,
      ]),
    );
    mutableRecord(input.catalog.symbols)[authSchemeId] = {
      id: authSchemeId,
      kind: "securityScheme",
      schemeType: "oauth2",
      docs: docsFrom({
        summary: "OAuth 2.0",
        description: "Imported from Google Discovery scopes.",
      }),
      oauth: {
        flows: {},
        scopes: scopeDescriptions,
      },
      synthetic: false,
      provenance: provenanceFor(input.documentId, "#/googleDiscovery/security"),
    } satisfies SecuritySchemeSymbol;
  }

  const parameterIds = input.operation.providerData.invocation.parameters.map((parameter) => {
    const parameterId = ParameterSymbolIdSchema.make(`param_${stableHash({
      capabilityId,
      location: parameter.location,
      name: parameter.name,
    })}`);
    const parameterSchema = groupedSchemaForParameter(inputSchema, parameter.location, parameter.name)
      ?? (parameter.repeated
        ? {
            type: "array",
            items: {
              type: parameter.type === "integer" ? "integer" : "string",
              ...(parameter.enum ? { enum: parameter.enum } : {}),
            },
          }
        : {
            type: parameter.type === "integer" ? "integer" : "string",
            ...(parameter.enum ? { enum: parameter.enum } : {}),
          });

    mutableRecord(input.catalog.symbols)[parameterId] = {
      id: parameterId,
      kind: "parameter",
      name: parameter.name,
      location: parameter.location,
      required: parameter.required,
      ...(docsFrom({
        description: parameter.description,
      })
        ? {
            docs: docsFrom({
              description: parameter.description,
            })!,
          }
        : {}),
      schemaShapeId: input.importer.importSchema(
        parameterSchema,
        `#/googleDiscovery/${input.operation.providerData.toolId}/parameter/${parameter.location}/${parameter.name}`,
      ),
      synthetic: false,
      provenance: provenanceFor(
        input.documentId,
        `#/googleDiscovery/${input.operation.providerData.toolId}/parameter/${parameter.location}/${parameter.name}`,
      ),
    } satisfies ParameterSymbol;
    return parameterId;
  });

  const requestBodyId = input.operation.providerData.invocation.requestSchemaId || requestBodySchemaFromInput(inputSchema) !== undefined
    ? RequestBodySymbolIdSchema.make(`request_body_${stableHash({ capabilityId })}`)
    : undefined;

  if (requestBodyId) {
    const requestBodySchema = requestBodySchemaFromInput(inputSchema) ?? inputSchema;
    mutableRecord(input.catalog.symbols)[requestBodyId] = {
      id: requestBodyId,
      kind: "requestBody",
      contents: [{
        mediaType: "application/json",
        shapeId: input.importer.importSchema(
          requestBodySchema,
          `#/googleDiscovery/${input.operation.providerData.toolId}/requestBody`,
        ),
      }],
      synthetic: false,
      provenance: provenanceFor(input.documentId, `#/googleDiscovery/${input.operation.providerData.toolId}/requestBody`),
    };
  }

  const responseId = ResponseSymbolIdSchema.make(`response_${stableHash({ capabilityId })}`);
  mutableRecord(input.catalog.symbols)[responseId] = {
    id: responseId,
    kind: "response",
    ...(docsFrom({
      description: input.operation.description,
    })
      ? {
          docs: docsFrom({
            description: input.operation.description,
          })!,
        }
      : {}),
    ...(input.operation.outputSchema !== undefined
      ? {
          contents: [{
            mediaType: "application/json",
            shapeId: input.importer.importSchema(
              outputSchema,
              `#/googleDiscovery/${input.operation.providerData.toolId}/response`,
            ),
          }],
        }
      : {}),
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/googleDiscovery/${input.operation.providerData.toolId}/response`),
  } satisfies ResponseSymbol;

  const traits: Array<"upload" | "download"> = [];
  if (input.operation.providerData.invocation.supportsMediaUpload) {
    traits.push("upload");
  }
  if (input.operation.providerData.invocation.supportsMediaDownload) {
    traits.push("download");
  }

  const responseSetId = responseSetFromSingleResponse({
    catalog: input.catalog,
    responseId,
    provenance: provenanceFor(input.documentId, `#/googleDiscovery/${input.operation.providerData.toolId}/responseSet`),
    traits,
  });

  mutableRecord(input.catalog.executables)[executableId] = {
    id: executableId,
    protocol: "http",
    capabilityId,
    scopeId: input.serviceScopeId,
    method: input.operation.providerData.invocation.method.toUpperCase(),
    pathTemplate: input.operation.providerData.invocation.path,
    pathParameterIds: parameterIds.filter((parameterId) => (input.catalog.symbols[parameterId] as ParameterSymbol | undefined)?.location === "path"),
    queryParameterIds: parameterIds.filter((parameterId) => (input.catalog.symbols[parameterId] as ParameterSymbol | undefined)?.location === "query"),
    headerParameterIds: parameterIds.filter((parameterId) => (input.catalog.symbols[parameterId] as ParameterSymbol | undefined)?.location === "header"),
    ...(requestBodyId ? { requestBodyId } : {}),
    responseSetId,
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/googleDiscovery/${input.operation.providerData.toolId}/executable`),
  } satisfies HttpExecutable;

  const effect = input.operation.effect;
  const auth: AuthRequirement =
    authSchemeId
      ? {
          kind: "scheme",
          schemeId: authSchemeId,
          scopes: input.operation.providerData.invocation.scopes,
        }
      : { kind: "none" };

  mutableRecord(input.catalog.capabilities)[capabilityId] = {
    id: capabilityId,
    serviceScopeId: input.serviceScopeId,
    surface: {
      toolPath,
      ...(input.operation.title ? { title: input.operation.title } : {}),
      ...(input.operation.description ? { summary: input.operation.description } : {}),
      tags: ["google", input.operation.providerData.service, input.operation.providerData.version],
    },
    semantics: {
      effect,
      safe: effect === "read",
      idempotent: effect === "read" || effect === "delete",
      destructive: effect === "delete",
    },
    auth,
    interaction: interactionForEffect(effect),
    executableIds: [executableId],
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/googleDiscovery/${input.operation.providerData.toolId}/capability`),
  } satisfies Capability;
};

const createGraphqlCapability = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  serviceScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: GraphqlCatalogOperationInput;
  importer: JsonSchemaImporter;
}) => {
  const toolPath = toolPathSegments(input.source, input.operation.providerData.toolId);
  const capabilityId = CapabilityIdSchema.make(`cap_${stableHash({
    sourceId: input.source.id,
    toolId: input.operation.providerData.toolId,
  })}`);
  const executableId = ExecutableIdSchema.make(`exec_${stableHash({
    sourceId: input.source.id,
    toolId: input.operation.providerData.toolId,
    protocol: "graphql",
  })}`);
  const argumentShapeId = input.operation.inputSchema !== undefined
    ? input.importer.importSchema(
        input.operation.inputSchema,
        `#/graphql/${input.operation.providerData.toolId}/input`,
      )
    : input.importer.importSchema(
        {
          type: "object",
          additionalProperties: true,
        },
        `#/graphql/${input.operation.providerData.toolId}/input`,
      );
  const resultShapeId = input.operation.outputSchema !== undefined
    ? input.importer.importSchema(
        input.operation.outputSchema,
        `#/graphql/${input.operation.providerData.toolId}/output`,
      )
    : input.importer.importSchema(
        {
          type: "object",
          additionalProperties: true,
        },
        `#/graphql/${input.operation.providerData.toolId}/output`,
      );

  const responseId = ResponseSymbolIdSchema.make(`response_${stableHash({ capabilityId })}`);
  mutableRecord(input.catalog.symbols)[responseId] = {
    id: responseId,
    kind: "response",
    ...(docsFrom({
      description: input.operation.description,
    })
      ? {
          docs: docsFrom({
            description: input.operation.description,
          })!,
        }
      : {}),
    contents: [{
      mediaType: "application/json",
      shapeId: resultShapeId,
    }],
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/graphql/${input.operation.providerData.toolId}/response`),
  } satisfies ResponseSymbol;

  const responseSetId = responseSetFromSingleResponse({
    catalog: input.catalog,
    responseId,
    provenance: provenanceFor(input.documentId, `#/graphql/${input.operation.providerData.toolId}/responseSet`),
  });

  mutableRecord(input.catalog.executables)[executableId] = {
    id: executableId,
    protocol: "graphql",
    capabilityId,
    scopeId: input.serviceScopeId,
    toolKind: input.operation.providerData.toolKind,
    operationType: input.operation.providerData.operationType ?? "query",
    rootField:
      input.operation.providerData.fieldName
      ?? input.operation.providerData.leaf
      ?? input.operation.providerData.toolId,
    ...(input.operation.providerData.operationName
      ? { operationName: input.operation.providerData.operationName }
      : {}),
    ...(input.operation.providerData.operationDocument
      ? { operationDocument: input.operation.providerData.operationDocument }
      : {}),
    argumentShapeId,
    resultShapeId,
    selectionMode: "fixed",
    responseSetId,
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/graphql/${input.operation.providerData.toolId}/executable`),
  } satisfies GraphQLExecutable;

  const effect = input.operation.effect;

  mutableRecord(input.catalog.capabilities)[capabilityId] = {
    id: capabilityId,
    serviceScopeId: input.serviceScopeId,
    surface: {
      toolPath,
      ...(input.operation.title ? { title: input.operation.title } : {}),
      ...(input.operation.description ? { summary: input.operation.description } : {}),
      ...(input.operation.providerData.group ? { tags: [input.operation.providerData.group] } : {}),
    },
    semantics: {
      effect,
      safe: effect === "read",
      idempotent: effect === "read",
      destructive: false,
    },
    auth: { kind: "none" },
    interaction: interactionForEffect(effect),
    executableIds: [executableId],
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/graphql/${input.operation.providerData.toolId}/capability`),
  } satisfies Capability;
};

const createMcpCapability = (input: {
  catalog: CatalogV1;
  source: Source;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  serviceScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: McpCatalogOperationInput;
  importer: JsonSchemaImporter;
}) => {
  const toolPath = toolPathSegments(input.source, input.operation.providerData.toolId);
  const capabilityId = CapabilityIdSchema.make(`cap_${stableHash({
    sourceId: input.source.id,
    toolId: input.operation.providerData.toolId,
  })}`);
  const executableId = ExecutableIdSchema.make(`exec_${stableHash({
    sourceId: input.source.id,
    toolId: input.operation.providerData.toolId,
    protocol: "mcp",
  })}`);
  const inputShapeId = input.operation.inputSchema !== undefined
    ? input.importer.importSchema(
        input.operation.inputSchema,
        `#/mcp/${input.operation.providerData.toolId}/input`,
      )
    : undefined;
  const outputShapeId = input.operation.outputSchema !== undefined
    ? input.importer.importSchema(
        input.operation.outputSchema,
        `#/mcp/${input.operation.providerData.toolId}/output`,
      )
    : undefined;

  const responseId = ResponseSymbolIdSchema.make(`response_${stableHash({ capabilityId })}`);
  mutableRecord(input.catalog.symbols)[responseId] = {
    id: responseId,
    kind: "response",
    ...(docsFrom({
      description: input.operation.providerData.description ?? input.operation.description,
    })
      ? {
          docs: docsFrom({
            description: input.operation.providerData.description ?? input.operation.description,
          })!,
        }
      : {}),
    ...(outputShapeId
      ? {
          contents: [{
            mediaType: "application/json",
            shapeId: outputShapeId,
          }],
        }
      : {}),
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/mcp/${input.operation.providerData.toolId}/response`),
  } satisfies ResponseSymbol;
  const responseSetId = responseSetFromSingleResponse({
    catalog: input.catalog,
    responseId,
    provenance: provenanceFor(input.documentId, `#/mcp/${input.operation.providerData.toolId}/responseSet`),
  });

  mutableRecord(input.catalog.executables)[executableId] = {
    id: executableId,
    protocol: "mcp",
    capabilityId,
    scopeId: input.serviceScopeId,
    serverRef: input.source.endpoint,
    toolName: input.operation.providerData.toolName,
    ...(inputShapeId ? { inputShapeId } : {}),
    ...(outputShapeId ? { outputShapeId } : {}),
    responseSetId,
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/mcp/${input.operation.providerData.toolId}/executable`),
  } satisfies McpExecutable;

  const interaction = interactionForEffect(input.operation.effect);
  mutableRecord(input.catalog.capabilities)[capabilityId] = {
    id: capabilityId,
    serviceScopeId: input.serviceScopeId,
    surface: {
      toolPath,
      title: input.operation.providerData.displayTitle,
      ...(input.operation.providerData.description ? { summary: input.operation.providerData.description } : {}),
    },
    semantics: mcpSemanticsForOperation({
      effect: input.operation.effect,
      annotations: input.operation.providerData.annotations,
    }),
    auth: { kind: "none" },
    interaction: {
      ...interaction,
      resume: {
        supported: mcpResumeSupport(input.operation.providerData.execution),
      },
    },
    executableIds: [executableId],
    synthetic: false,
    provenance: provenanceFor(input.documentId, `#/mcp/${input.operation.providerData.toolId}/capability`),
  } satisfies Capability;
};

const buildCatalogSnapshot = (input: {
  source: Source;
  adapterKey: string;
  documents: readonly CatalogSourceDocumentInput[];
  serviceScopeDefaults?: Scope["defaults"];
  registerOperations: (context: {
    catalog: CatalogV1;
    documentId: ReturnType<typeof DocumentIdSchema.make>;
    serviceScopeId: ReturnType<typeof ScopeIdSchema.make>;
    importer: JsonSchemaImporter;
  }) => void;
}): CatalogSnapshotV1 => {
  const catalog = createEmptyCatalogV1();
  const documents = input.documents.length > 0
    ? input.documents
    : [{
        documentKind: "synthetic",
        documentKey: input.source.endpoint,
        fetchedAt: Date.now(),
        contentText: "{}",
      }];
  const primaryDocument = documents[0]!;
  const primaryDocumentKey =
    primaryDocument.documentKey
    ?? input.source.endpoint
    ?? input.source.id;
  const primaryDocumentId = documentIdFor(
    input.source,
    `${primaryDocument.documentKind}:${primaryDocument.documentKey}`,
  );
  const primaryResourceId = resourceIdForSource(input.source);

  for (const document of documents) {
    const documentId = documentIdFor(input.source, `${document.documentKind}:${document.documentKey}`);
    mutableRecord(catalog.documents)[documentId] = {
      id: documentId,
      kind: sourceKindFromSource(input.source),
      title: input.source.name,
      fetchedAt: new Date(document.fetchedAt ?? Date.now()).toISOString(),
      rawRef: document.documentKey,
      entryUri: document.documentKey.startsWith("http") ? document.documentKey : undefined,
      native: [nativeBlob({
        source: input.source,
        kind: "source_document",
        pointer: `#/${document.documentKind}`,
        value: document.contentText,
        summary: document.documentKind,
      })],
    } satisfies SourceDocument;
  }

  mutableRecord(catalog.resources)[primaryResourceId] = {
    id: primaryResourceId,
    documentId: primaryDocumentId,
    canonicalUri: primaryDocumentKey,
    baseUri: primaryDocumentKey,
    ...(input.source.kind === "openapi" || input.source.kind === "graphql"
      ? {
          dialectUri:
            input.source.kind === "openapi"
              ? "https://json-schema.org/draft/2020-12/schema"
              : "https://spec.graphql.org/",
        }
      : {}),
    anchors: {},
    dynamicAnchors: {},
    synthetic: false,
    provenance: provenanceFor(primaryDocumentId, "#"),
  };

  const serviceScopeId = createServiceScope({
    catalog,
    source: input.source,
    documentId: primaryDocumentId,
    defaults: input.serviceScopeDefaults,
  });
  const importer = createJsonSchemaImporter({
    catalog,
    source: input.source,
    resourceId: primaryResourceId,
    documentId: primaryDocumentId,
  });
  input.registerOperations({
    catalog,
    documentId: primaryDocumentId,
    serviceScopeId,
    importer,
  });
  importer.finalize();

  const snapshot = createCatalogSnapshotV1({
    import: importMetadataFor(input),
    catalog,
  });

  return snapshot;
};

export const createOpenApiCatalogSnapshot = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly OpenApiCatalogOperationInput[];
}): CatalogSnapshotV1 => {
  const rootSchema = (() => {
    const primaryDocumentText = input.documents[0]?.contentText;
    if (!primaryDocumentText) {
      return undefined;
    }

    try {
      return JSON.parse(primaryDocumentText) as unknown;
    } catch {
      return undefined;
    }
  })();

  return buildCatalogSnapshot({
    source: input.source,
    adapterKey: "openapi",
    documents: input.documents,
    serviceScopeDefaults: (() => {
      const documentServers = openApiServerSpecs(
        input.operations.find((operation) =>
          (operation.providerData.documentServers ?? []).length > 0
        )?.providerData.documentServers,
      );

      return documentServers ? { servers: documentServers } : undefined;
    })(),
    registerOperations: ({ catalog, documentId, serviceScopeId, importer }) => {
      for (const operation of input.operations) {
        createHttpCapabilityFromOpenApi({
          catalog,
          source: input.source,
          documentId,
          serviceScopeId,
          operation,
          importer,
          rootSchema,
        });
      }
    },
  });
};

export const createGoogleDiscoveryCatalogSnapshot = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly GoogleDiscoveryCatalogOperationInput[];
}): CatalogSnapshotV1 =>
  buildCatalogSnapshot({
    source: input.source,
    adapterKey: "google_discovery",
    documents: input.documents,
    serviceScopeDefaults: (() => {
      const servers = googleDiscoveryServerSpecs(input.operations[0]);
      return servers ? { servers } : undefined;
    })(),
    registerOperations: ({ catalog, documentId, serviceScopeId, importer }) => {
      for (const operation of input.operations) {
        createHttpCapabilityFromGoogleDiscovery({
          catalog,
          source: input.source,
          documentId,
          serviceScopeId,
          operation,
          importer,
        });
      }
    },
  });

export const createGraphqlCatalogSnapshot = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly GraphqlCatalogOperationInput[];
}): CatalogSnapshotV1 =>
  buildCatalogSnapshot({
    source: input.source,
    adapterKey: "graphql",
    documents: input.documents,
    registerOperations: ({ catalog, documentId, serviceScopeId, importer }) => {
      for (const operation of input.operations) {
        createGraphqlCapability({
          catalog,
          source: input.source,
          documentId,
          serviceScopeId,
          operation,
          importer,
        });
      }
    },
  });

export const createMcpCatalogSnapshot = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly McpCatalogOperationInput[];
}): CatalogSnapshotV1 =>
  buildCatalogSnapshot({
    source: input.source,
    adapterKey: "mcp",
    documents: input.documents,
    registerOperations: ({ catalog, documentId, serviceScopeId, importer }) => {
      for (const operation of input.operations) {
        createMcpCapability({
          catalog,
          source: input.source,
          documentId,
          serviceScopeId,
          operation,
          importer,
        });
      }
    },
  });
