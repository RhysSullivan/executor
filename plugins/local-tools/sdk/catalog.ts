import {
  CapabilityIdSchema,
  DocumentIdSchema,
  ExecutableIdSchema,
  ResponseSymbolIdSchema,
  ScopeIdSchema,
} from "@executor/ir/ids";
import type {
  Capability,
  Executable,
  ResponseSymbol,
} from "@executor/ir/model";
import type {
  ToolDescriptor,
} from "@executor/codemode-core";
import {
  EXECUTABLE_BINDING_VERSION,
  buildCatalogFragment,
  docsFrom,
  interactionForEffect,
  isObjectLikeJsonSchema,
  mutableRecord,
  provenanceFor,
  responseSetFromSingleResponse,
  schemaWithMergedDefs,
  stableHash,
  type CatalogFragmentBuilder,
  type CatalogSourceDocumentInput,
  type JsonSchemaImporter,
  type Source,
} from "@executor/source-core";

export type LocalToolsCatalogOperationInput = {
  descriptor: ToolDescriptor;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

const leafFromPath = (path: string): string =>
  path.split(".").filter((segment) => segment.length > 0).at(-1) ?? path;

const toolPathSegmentsFromDescriptor = (descriptor: ToolDescriptor): string[] =>
  descriptor.path.split(".").filter((segment) => segment.length > 0);

const invocationInputMode = (
  schema: unknown,
): "direct" | "wrapped" =>
  schema === undefined || isObjectLikeJsonSchema(schema) ? "direct" : "wrapped";

const createLocalToolCapability = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "id">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  serviceScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: LocalToolsCatalogOperationInput;
  importer: JsonSchemaImporter;
}) => {
  const toolPath = toolPathSegmentsFromDescriptor(input.operation.descriptor);
  const pathText = toolPath.join(".");
  const capabilityId = CapabilityIdSchema.make(
    `cap_${stableHash({
      sourceId: input.source.id,
      toolPath: pathText,
    })}`,
  );
  const executableId = ExecutableIdSchema.make(
    `exec_${stableHash({
      sourceId: input.source.id,
      toolPath: pathText,
      protocol: "local-tools",
    })}`,
  );
  const inputSchema = input.operation.inputSchema;
  const callShapeId =
    inputSchema === undefined
      ? input.importer.importSchema(
          {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          `#/local-tools/${pathText}/call`,
        )
      : invocationInputMode(inputSchema) === "direct"
        ? input.importer.importSchema(
            inputSchema,
            `#/local-tools/${pathText}/call`,
            inputSchema,
          )
        : input.importer.importSchema(
            schemaWithMergedDefs(
              {
                type: "object",
                properties: {
                  input: inputSchema,
                },
                required: ["input"],
                additionalProperties: false,
              },
              inputSchema,
            ),
            `#/local-tools/${pathText}/call`,
          );
  const outputShapeId =
    input.operation.outputSchema !== undefined
      ? input.importer.importSchema(
          input.operation.outputSchema,
          `#/local-tools/${pathText}/output`,
        )
      : undefined;
  const resultStatusShapeId = input.importer.importSchema(
    { type: "null" },
    `#/local-tools/${pathText}/status`,
  );

  const responseId = ResponseSymbolIdSchema.make(
    `response_${stableHash({ capabilityId })}`,
  );
  mutableRecord(input.catalog.symbols)[responseId] = {
    id: responseId,
    kind: "response",
    ...(docsFrom({
      description: input.operation.descriptor.description,
    })
      ? {
          docs: docsFrom({
            description: input.operation.descriptor.description,
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
      `#/local-tools/${pathText}/response`,
    ),
  } satisfies ResponseSymbol;
  const responseSetId = responseSetFromSingleResponse({
    catalog: input.catalog,
    responseId,
    provenance: provenanceFor(
      input.documentId,
      `#/local-tools/${pathText}/responseSet`,
    ),
  });

  mutableRecord(input.catalog.executables)[executableId] = {
    id: executableId,
    capabilityId,
    scopeId: input.serviceScopeId,
    pluginKey: "local-tools",
    bindingVersion: EXECUTABLE_BINDING_VERSION,
    binding: {
      toolPath: pathText,
      invocationInput: invocationInputMode(inputSchema),
    },
    projection: {
      responseSetId,
      callShapeId,
      ...(outputShapeId ? { resultDataShapeId: outputShapeId } : {}),
      resultStatusShapeId,
    },
    display: {
      protocol: "local-tools",
      method: null,
      pathTemplate: null,
      operationId: pathText,
      group: toolPath.length > 1 ? toolPath.slice(0, -1).join(".") : null,
      leaf: leafFromPath(pathText),
      rawToolId: pathText,
      title: pathText,
      summary: input.operation.descriptor.description ?? null,
    },
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/local-tools/${pathText}/executable`,
    ),
  } satisfies Executable;

  const effect =
    input.operation.descriptor.interaction === "required"
      ? "action"
      : "read";
  mutableRecord(input.catalog.capabilities)[capabilityId] = {
    id: capabilityId,
    serviceScopeId: input.serviceScopeId,
    surface: {
      toolPath,
      title: pathText,
      ...(input.operation.descriptor.description
        ? { summary: input.operation.descriptor.description }
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
      `#/local-tools/${pathText}/capability`,
    ),
  } satisfies Capability;
};

export const createLocalToolsCatalogFragment = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly LocalToolsCatalogOperationInput[];
}) =>
  buildCatalogFragment({
    source: input.source,
    documents: input.documents,
    registerOperations: ({ catalog, documentId, serviceScopeId, importer }) => {
      for (const operation of input.operations) {
        createLocalToolCapability({
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
