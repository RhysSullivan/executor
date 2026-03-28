import { createCatalogSnapshotV1FromFragments } from "@executor/ir/catalog";
import {
  CapabilityIdSchema,
  DocumentIdSchema,
  ExecutableIdSchema,
  ResponseSymbolIdSchema,
  ScopeIdSchema,
} from "@executor/ir/ids";
import type {
  Capability,
  CatalogSnapshotV1,
  ResponseSymbol,
  Executable,
} from "@executor/ir/model";
import {
  type BaseCatalogOperationInput,
  type CatalogFragmentBuilder,
  type CatalogSourceDocumentInput,
  type JsonSchemaImporter,
  type Source,
  EXECUTABLE_BINDING_VERSION,
  asJsonRecord,
  buildCatalogFragment,
  createCatalogImportMetadata,
  docsFrom,
  interactionForEffect,
  mutableRecord,
  provenanceFor,
  responseSetFromSingleResponse,
  schemaWithMergedDefs,
  stableHash,
  toolPathSegments,
} from "@executor/source-core";

import type { GraphqlToolProviderData } from "./provider-data";

export type GraphqlCatalogOperationInput = BaseCatalogOperationInput & {
  providerData: GraphqlToolProviderData;
};

const graphqlErrorItemsJsonSchema = (): Record<string, unknown> => ({
  type: "array",
  items: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "GraphQL error message.",
      },
      path: {
        type: "array",
        description: "Path to the field that produced the error.",
        items: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
      locations: {
        type: "array",
        description: "Source locations for the error in the GraphQL document.",
        items: {
          type: "object",
          properties: {
            line: { type: "number" },
            column: { type: "number" },
          },
          required: ["line", "column"],
          additionalProperties: false,
        },
      },
      extensions: {
        type: "object",
        description: "Additional provider-specific GraphQL error metadata.",
        additionalProperties: true,
      },
    },
    required: ["message"],
    additionalProperties: true,
  },
});

const graphqlProjectedResultDataSchema = (input: {
  toolKind: "request" | "field";
  outputSchema: unknown;
}): Record<string, unknown> => {
  if (input.toolKind !== "field") {
    return asJsonRecord(input.outputSchema);
  }

  const outputSchema = asJsonRecord(input.outputSchema);
  const dataSchema = asJsonRecord(asJsonRecord(outputSchema.properties).data);

  return Object.keys(dataSchema).length > 0
    ? schemaWithMergedDefs(dataSchema, input.outputSchema)
    : outputSchema;
};

const graphqlProjectedResultErrorSchema = (input: {
  toolKind: "request" | "field";
  outputSchema: unknown;
}): Record<string, unknown> => {
  if (input.toolKind !== "field") {
    return graphqlErrorItemsJsonSchema();
  }

  const outputSchema = asJsonRecord(input.outputSchema);
  const errorsSchema = asJsonRecord(
    asJsonRecord(outputSchema.properties).errors,
  );

  return Object.keys(errorsSchema).length > 0
    ? schemaWithMergedDefs(errorsSchema, input.outputSchema)
    : graphqlErrorItemsJsonSchema();
};

const createGraphqlCapability = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "id" | "name" | "namespace">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  serviceScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: GraphqlCatalogOperationInput;
  importer: JsonSchemaImporter;
}) => {
  const toolPath = toolPathSegments(
    input.source,
    input.operation.providerData.toolId,
  );
  const capabilityId = CapabilityIdSchema.make(
    `cap_${stableHash({
      sourceId: input.source.id,
      toolId: input.operation.providerData.toolId,
    })}`,
  );
  const executableId = ExecutableIdSchema.make(
    `exec_${stableHash({
      sourceId: input.source.id,
      toolId: input.operation.providerData.toolId,
      protocol: "graphql",
    })}`,
  );
  const callShapeId =
    input.operation.inputSchema !== undefined
      ? input.importer.importSchema(
          input.operation.inputSchema,
          `#/graphql/${input.operation.providerData.toolId}/call`,
        )
      : input.importer.importSchema(
          {
            type: "object",
            additionalProperties: true,
          },
          `#/graphql/${input.operation.providerData.toolId}/call`,
        );
  const resultDataShapeId =
    input.operation.outputSchema !== undefined
      ? input.importer.importSchema(
          graphqlProjectedResultDataSchema({
            toolKind: input.operation.providerData.toolKind,
            outputSchema: input.operation.outputSchema,
          }),
          `#/graphql/${input.operation.providerData.toolId}/data`,
        )
      : input.importer.importSchema(
          {
            type: "object",
            additionalProperties: true,
          },
          `#/graphql/${input.operation.providerData.toolId}/data`,
        );
  const resultErrorShapeId = input.importer.importSchema(
    graphqlProjectedResultErrorSchema({
      toolKind: input.operation.providerData.toolKind,
      outputSchema: input.operation.outputSchema,
    }),
    `#/graphql/${input.operation.providerData.toolId}/errors`,
  );

  const responseId = ResponseSymbolIdSchema.make(
    `response_${stableHash({ capabilityId })}`,
  );
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
    contents: [
      {
        mediaType: "application/json",
        shapeId: resultDataShapeId,
      },
    ],
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/graphql/${input.operation.providerData.toolId}/response`,
    ),
  } satisfies ResponseSymbol;

  const responseSetId = responseSetFromSingleResponse({
    catalog: input.catalog,
    responseId,
    provenance: provenanceFor(
      input.documentId,
      `#/graphql/${input.operation.providerData.toolId}/responseSet`,
    ),
  });

  mutableRecord(input.catalog.executables)[executableId] = {
    id: executableId,
    capabilityId,
    scopeId: input.serviceScopeId,
    pluginKey: "graphql",
    bindingVersion: EXECUTABLE_BINDING_VERSION,
    binding: input.operation.providerData,
    projection: {
      responseSetId,
      callShapeId,
      resultDataShapeId,
      resultErrorShapeId,
    },
    display: {
      protocol: "graphql",
      method: input.operation.providerData.operationType ?? "query",
      pathTemplate:
        input.operation.providerData.fieldName ??
        input.operation.providerData.leaf ??
        input.operation.providerData.toolId,
      operationId:
        input.operation.providerData.fieldName ??
        input.operation.providerData.leaf ??
        input.operation.providerData.toolId,
      group: input.operation.providerData.group,
      leaf: input.operation.providerData.leaf,
      rawToolId: input.operation.providerData.toolId,
      title: input.operation.title ?? null,
      summary: input.operation.description ?? null,
    },
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/graphql/${input.operation.providerData.toolId}/executable`,
    ),
  } satisfies Executable;

  const effect = input.operation.effect;

  mutableRecord(input.catalog.capabilities)[capabilityId] = {
    id: capabilityId,
    serviceScopeId: input.serviceScopeId,
    surface: {
      toolPath,
      ...(input.operation.title ? { title: input.operation.title } : {}),
      ...(input.operation.description
        ? { summary: input.operation.description }
        : {}),
      ...(input.operation.providerData.group
        ? { tags: [input.operation.providerData.group] }
        : {}),
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
    provenance: provenanceFor(
      input.documentId,
      `#/graphql/${input.operation.providerData.toolId}/capability`,
    ),
  } satisfies Capability;
};

export const createGraphqlCatalogFragment = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly GraphqlCatalogOperationInput[];
}) =>
  buildCatalogFragment({
    source: input.source,
    documents: input.documents,
    resourceDialectUri: "https://spec.graphql.org/",
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

export const createGraphqlCatalogSnapshot = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly GraphqlCatalogOperationInput[];
}): CatalogSnapshotV1 =>
  createCatalogSnapshotV1FromFragments({
    import: createCatalogImportMetadata({
      source: input.source,
      pluginKey: "graphql",
    }),
    fragments: [createGraphqlCatalogFragment(input)],
  });
