import { sha256Hex } from "@executor/codemode-core";
import {
  DocumentIdSchema,
  ExampleSymbolIdSchema,
  ResponseSetIdSchema,
  ResponseSymbolIdSchema,
} from "@executor/ir/ids";
import type {
  Capability,
  DocumentationBlock,
  EffectKind,
  ExampleSymbol,
  ImportMetadata,
  ProvenanceRef,
  ResponseSet,
  SourceKind,
} from "@executor/ir/model";

import { namespaceFromSourceName } from "./discovery";
import type { Source } from "./source-models";
import type { CatalogFragmentBuilder } from "./catalog-types";

export const stableStringify = (value: unknown): string => {
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

export const stableHash = (value: unknown): string =>
  sha256Hex(stableStringify(value)).slice(0, 16);

export const mutableRecord = <K extends string, V>(
  value: Readonly<Record<K, V>>,
): Record<K, V> => value as unknown as Record<K, V>;

export const asJsonRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const mergedJsonSchemaDefs = (
  ...schemas: Array<unknown | undefined>
): Record<string, unknown> | undefined => {
  const defs: Record<string, unknown> = {};

  for (const schema of schemas) {
    const schemaDefs = asJsonRecord(asJsonRecord(schema).$defs);
    for (const [key, value] of Object.entries(schemaDefs)) {
      defs[key] = value;
    }
  }

  return Object.keys(defs).length > 0 ? defs : undefined;
};

export const schemaWithMergedDefs = (
  schema: Record<string, unknown>,
  ...schemas: Array<unknown | undefined>
): Record<string, unknown> => {
  const defs = mergedJsonSchemaDefs(schema, ...schemas);
  return defs ? { ...schema, $defs: defs } : schema;
};

export const isObjectLikeJsonSchema = (schema: unknown): boolean => {
  const record = asJsonRecord(schema);
  return record.type === "object" || record.properties !== undefined;
};

export const sourceKindFromSource = (
  _source: Pick<Source, "kind">,
): SourceKind => "custom";

export const toolPathSegments = (
  source: Pick<Source, "name" | "namespace">,
  toolId: string,
): string[] => {
  const namespace = source.namespace ?? namespaceFromSourceName(source.name);
  const fullPath = namespace ? `${namespace}.${toolId}` : toolId;
  return fullPath.split(".").filter((segment) => segment.length > 0);
};

export const provenanceFor = (
  documentId: ReturnType<typeof DocumentIdSchema.make>,
  pointer: string,
): ProvenanceRef[] => [
  {
    relation: "declared",
    documentId,
    pointer,
  },
];

export const interactionForEffect = (
  effect: EffectKind,
): Capability["interaction"] => ({
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

export const createCatalogImportMetadata = (input: {
  source: Pick<Source, "id" | "kind">;
  pluginKey: string;
}): ImportMetadata => ({
  sourceKind: sourceKindFromSource(input.source),
  pluginKey: input.pluginKey,
  importerVersion: "ir.v1.snapshot_builder",
  importedAt: new Date().toISOString(),
  sourceConfigHash: stableHash({
    sourceId: input.source.id,
  }),
});

export const docsFrom = (input: {
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

export const exampleSymbolFromValue = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "kind">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  pointer: string;
  name?: string;
  value: unknown;
  summary?: string;
  description?: string;
}): ReturnType<typeof ExampleSymbolIdSchema.make> => {
  const exampleId = ExampleSymbolIdSchema.make(
    `example_${stableHash({
      pointer: input.pointer,
      value: input.value,
    })}`,
  );
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
  const record = asJsonRecord(schema);
  const properties = asJsonRecord(record.properties);
  if (properties[fieldName] !== undefined) {
    return properties[fieldName];
  }
  return undefined;
};

export const groupedSchemaForParameter = (
  schema: unknown,
  location: string,
  name: string,
): unknown => {
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
  return groupSchema === undefined
    ? undefined
    : schemaFromField(groupSchema, name);
};

export const requestBodySchemaFromInput = (schema: unknown): unknown =>
  schemaFromField(schema, "body") ?? schemaFromField(schema, "input");

export const preferredResponseContentTypes = (
  mediaTypes: readonly string[] | undefined,
): string[] => {
  const candidates =
    mediaTypes && mediaTypes.length > 0
      ? [...mediaTypes]
      : ["application/json"];

  const preferred = [
    ...candidates.filter((mediaType) => mediaType === "application/json"),
    ...candidates.filter(
      (mediaType) =>
        mediaType !== "application/json" &&
        mediaType.toLowerCase().includes("+json"),
    ),
    ...candidates.filter(
      (mediaType) =>
        mediaType !== "application/json" &&
        !mediaType.toLowerCase().includes("+json") &&
        mediaType.toLowerCase().includes("json"),
    ),
    ...candidates,
  ];

  return [...new Set(preferred)];
};

export const responseSetFromSingleResponse = (input: {
  catalog: CatalogFragmentBuilder;
  responseId: ReturnType<typeof ResponseSymbolIdSchema.make>;
  provenance: ProvenanceRef[];
  traits?: ResponseSet["variants"][number]["traits"];
}) => {
  const responseSetId = ResponseSetIdSchema.make(
    `response_set_${stableHash({
      responseId: input.responseId,
      traits: input.traits,
    })}`,
  );
  mutableRecord(input.catalog.responseSets)[responseSetId] = {
    id: responseSetId,
    variants: [
      {
        match: {
          kind: "range",
          value: "2XX",
        },
        responseId: input.responseId,
        ...(input.traits && input.traits.length > 0
          ? { traits: input.traits }
          : {}),
      },
    ],
    synthetic: false,
    provenance: input.provenance,
  } satisfies ResponseSet;
  return responseSetId;
};

export const responseSetFromVariants = (input: {
  catalog: CatalogFragmentBuilder;
  variants: ResponseSet["variants"];
  provenance: ProvenanceRef[];
}) => {
  const responseSetId = ResponseSetIdSchema.make(
    `response_set_${stableHash({
      variants: input.variants.map((variant) => ({
        match: variant.match,
        responseId: variant.responseId,
        traits: variant.traits,
      })),
    })}`,
  );
  mutableRecord(input.catalog.responseSets)[responseSetId] = {
    id: responseSetId,
    variants: input.variants,
    synthetic: false,
    provenance: input.provenance,
  } satisfies ResponseSet;
  return responseSetId;
};

export const statusMatchFromHttpStatusCode = (
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
