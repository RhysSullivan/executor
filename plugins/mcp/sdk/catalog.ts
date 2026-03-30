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
  buildCatalogFragment,
  createCatalogImportMetadata,
  docsFrom,
  interactionForEffect,
  isObjectLikeJsonSchema,
  mutableRecord,
  provenanceFor,
  responseSetFromSingleResponse,
  schemaWithMergedDefs,
  stableHash,
  toolPathSegments,
} from "@executor/source-core";

import { mcpExecutableBindingFromProviderData } from "./executable-binding";
import type {
  McpServerMetadata,
  McpToolAnnotations,
  McpToolExecution,
} from "./manifest";

export type McpCatalogOperationInput = BaseCatalogOperationInput & {
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

const mcpResumeSupport = (
  execution: McpCatalogOperationInput["providerData"]["execution"],
): boolean =>
  execution?.taskSupport === "optional" ||
  execution?.taskSupport === "required";

const mcpSemanticsForOperation = (input: {
  effect: McpCatalogOperationInput["effect"];
  annotations: McpCatalogOperationInput["providerData"]["annotations"];
}): Capability["semantics"] => {
  const safe = input.effect === "read";

  return {
    effect: input.effect,
    safe,
    idempotent: safe || input.annotations?.idempotentHint === true,
    destructive: safe ? false : input.annotations?.destructiveHint !== false,
  };
};

const createMcpCapability = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "id" | "name" | "namespace">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  serviceScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: McpCatalogOperationInput;
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
      protocol: "mcp",
    })}`,
  );
  // MCP tools frequently omit outputSchema even when they return data.
  // Treat that as unknown rather than as an explicit null response.
  const outputShapeId =
    input.importer.importSchema(
      input.operation.outputSchema === undefined
        ? true
        : input.operation.outputSchema,
      `#/mcp/${input.operation.providerData.toolId}/output`,
    );
  const callShapeId =
    input.operation.inputSchema === undefined
      ? input.importer.importSchema(
        {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        `#/mcp/${input.operation.providerData.toolId}/call`,
      )
      : isObjectLikeJsonSchema(input.operation.inputSchema)
        ? input.importer.importSchema(
          input.operation.inputSchema,
          `#/mcp/${input.operation.providerData.toolId}/call`,
          input.operation.inputSchema,
        )
        : input.importer.importSchema(
          schemaWithMergedDefs(
            {
              type: "object",
              properties: {
                input: input.operation.inputSchema,
              },
              required: ["input"],
              additionalProperties: false,
            },
            input.operation.inputSchema,
          ),
          `#/mcp/${input.operation.providerData.toolId}/call`,
        );
  const resultStatusShapeId = input.importer.importSchema(
    { type: "null" },
    `#/mcp/${input.operation.providerData.toolId}/status`,
  );

  const responseId = ResponseSymbolIdSchema.make(
    `response_${stableHash({ capabilityId })}`,
  );
  mutableRecord(input.catalog.symbols)[responseId] = {
    id: responseId,
    kind: "response",
    ...(docsFrom({
      description:
        input.operation.providerData.description ?? input.operation.description,
    })
      ? {
        docs: docsFrom({
          description:
            input.operation.providerData.description ??
            input.operation.description,
        })!,
      }
      : {}),
    ...(outputShapeId
      ? {
        contents: [
          {
            mediaType: "application/json",
            shapeId: outputShapeId,
          },
        ],
      }
      : {}),
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/mcp/${input.operation.providerData.toolId}/response`,
    ),
  } satisfies ResponseSymbol;
  const responseSetId = responseSetFromSingleResponse({
    catalog: input.catalog,
    responseId,
    provenance: provenanceFor(
      input.documentId,
      `#/mcp/${input.operation.providerData.toolId}/responseSet`,
    ),
  });

  mutableRecord(input.catalog.executables)[executableId] = {
    id: executableId,
    capabilityId,
    scopeId: input.serviceScopeId,
    pluginKey: "mcp",
    bindingVersion: EXECUTABLE_BINDING_VERSION,
    binding: mcpExecutableBindingFromProviderData(input.operation.providerData),
    projection: {
      responseSetId,
      callShapeId,
      ...(outputShapeId ? { resultDataShapeId: outputShapeId } : {}),
      resultStatusShapeId,
    },
    display: {
      protocol: "mcp",
      method: null,
      pathTemplate: null,
      operationId: input.operation.providerData.toolName,
      group: null,
      leaf: input.operation.providerData.toolName,
      rawToolId: input.operation.providerData.toolId,
      title: input.operation.providerData.displayTitle,
      summary:
        input.operation.providerData.description ??
        input.operation.description ??
        null,
    },
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/mcp/${input.operation.providerData.toolId}/executable`,
    ),
  } satisfies Executable;

  const interaction = interactionForEffect(input.operation.effect);
  mutableRecord(input.catalog.capabilities)[capabilityId] = {
    id: capabilityId,
    serviceScopeId: input.serviceScopeId,
    surface: {
      toolPath,
      title: input.operation.providerData.displayTitle,
      ...(input.operation.providerData.description
        ? { summary: input.operation.providerData.description }
        : {}),
    },
    semantics: mcpSemanticsForOperation({
      effect: input.operation.effect,
      annotations: input.operation.providerData.annotations,
    }),
    auth: { kind: "none" },
    interaction: {
      ...interaction,
      approval: {
        mayRequire: false,
      },
      resume: {
        supported: mcpResumeSupport(input.operation.providerData.execution),
      },
    },
    executableIds: [executableId],
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/mcp/${input.operation.providerData.toolId}/capability`,
    ),
  } satisfies Capability;
};

export const createMcpCatalogFragment = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly McpCatalogOperationInput[];
}) =>
  buildCatalogFragment({
    source: input.source,
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

export const createMcpCatalogSnapshot = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly McpCatalogOperationInput[];
}): CatalogSnapshotV1 =>
  createCatalogSnapshotV1FromFragments({
    import: createCatalogImportMetadata({
      source: input.source,
      pluginKey: "mcp",
    }),
    fragments: [createMcpCatalogFragment(input)],
  });
