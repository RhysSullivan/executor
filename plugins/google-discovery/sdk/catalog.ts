import { createCatalogSnapshotV1FromFragments } from "@executor/ir/catalog";
import {
  CapabilityIdSchema,
  DocumentIdSchema,
  ExecutableIdSchema,
  ParameterSymbolIdSchema,
  RequestBodySymbolIdSchema,
  ResponseSymbolIdSchema,
  ScopeIdSchema,
  SecuritySchemeSymbolIdSchema,
} from "@executor/ir/ids";
import type {
  AuthRequirement,
  Capability,
  CatalogSnapshotV1,
  ParameterSymbol,
  ResponseSymbol,
  Scope,
  SecuritySchemeSymbol,
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
  groupedSchemaForParameter,
  interactionForEffect,
  mutableRecord,
  provenanceFor,
  requestBodySchemaFromInput,
  responseSetFromSingleResponse,
  stableHash,
  toolPathSegments,
} from "@executor/source-core";
import { GOOGLE_DISCOVERY_SOURCE_KIND } from "@executor/plugin-google-discovery-shared";

import type { GoogleDiscoveryToolProviderData } from "./types";

export type GoogleDiscoveryCatalogOperationInput = BaseCatalogOperationInput & {
  providerData: GoogleDiscoveryToolProviderData;
};

const googleDiscoveryServerSpecs = (
  operation: GoogleDiscoveryCatalogOperationInput | undefined,
): NonNullable<NonNullable<Scope["defaults"]>["servers"]> | undefined => {
  const rootUrl = operation?.providerData.invocation.rootUrl;
  if (!rootUrl) {
    return undefined;
  }

  const servicePath = operation?.providerData.invocation.servicePath ?? "";
  return [
    {
      url: new URL(servicePath || "", rootUrl).toString(),
    },
  ];
};

const createHttpCapabilityFromGoogleDiscovery = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "id" | "kind" | "name" | "namespace">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  serviceScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: GoogleDiscoveryCatalogOperationInput;
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
      protocol: "http",
    })}`,
  );
  const inputSchema = input.operation.inputSchema ?? {};
  const outputSchema = input.operation.outputSchema ?? {};

  const authSchemeId =
    input.operation.providerData.invocation.scopes.length > 0
      ? SecuritySchemeSymbolIdSchema.make(
          `security_${stableHash({
            sourceId: input.source.id,
            scopes: input.operation.providerData.invocation.scopes,
          })}`,
        )
      : undefined;

  if (authSchemeId && !input.catalog.symbols[authSchemeId]) {
    const scopeDescriptions = Object.fromEntries(
      input.operation.providerData.invocation.scopes.map((scope) => [
        scope,
        input.operation.providerData.invocation.scopeDescriptions?.[scope] ??
          scope,
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

  input.operation.providerData.invocation.parameters.forEach((parameter) => {
      const parameterId = ParameterSymbolIdSchema.make(
        `param_${stableHash({
          capabilityId,
          location: parameter.location,
          name: parameter.name,
        })}`,
      );
      const parameterSchema =
        groupedSchemaForParameter(
          inputSchema,
          parameter.location,
          parameter.name,
        ) ??
        (parameter.repeated
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
          inputSchema,
        ),
        synthetic: false,
        provenance: provenanceFor(
          input.documentId,
          `#/googleDiscovery/${input.operation.providerData.toolId}/parameter/${parameter.location}/${parameter.name}`,
        ),
      } satisfies ParameterSymbol;
    });

  const requestBodyId =
    input.operation.providerData.invocation.requestSchemaId ||
    requestBodySchemaFromInput(inputSchema) !== undefined
      ? RequestBodySymbolIdSchema.make(
          `request_body_${stableHash({ capabilityId })}`,
        )
      : undefined;

  if (requestBodyId) {
    const requestBodySchema =
      requestBodySchemaFromInput(inputSchema) ?? inputSchema;
    mutableRecord(input.catalog.symbols)[requestBodyId] = {
      id: requestBodyId,
      kind: "requestBody",
      contents: [
        {
          mediaType: "application/json",
          shapeId: input.importer.importSchema(
            requestBodySchema,
            `#/googleDiscovery/${input.operation.providerData.toolId}/requestBody`,
            inputSchema,
          ),
        },
      ],
      synthetic: false,
      provenance: provenanceFor(
        input.documentId,
        `#/googleDiscovery/${input.operation.providerData.toolId}/requestBody`,
      ),
    };
  }

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
    ...(input.operation.outputSchema !== undefined
      ? {
          contents: [
            {
              mediaType: "application/json",
              shapeId: input.importer.importSchema(
                outputSchema,
                `#/googleDiscovery/${input.operation.providerData.toolId}/response`,
                outputSchema,
              ),
            },
          ],
        }
      : {}),
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/googleDiscovery/${input.operation.providerData.toolId}/response`,
    ),
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
    provenance: provenanceFor(
      input.documentId,
      `#/googleDiscovery/${input.operation.providerData.toolId}/responseSet`,
    ),
    traits,
  });

  const callShapeId =
    input.operation.inputSchema !== undefined
      ? input.importer.importSchema(
          input.operation.inputSchema,
          `#/googleDiscovery/${input.operation.providerData.toolId}/call`,
          input.operation.inputSchema,
        )
      : input.importer.importSchema(
          {
            type: "object",
            additionalProperties: false,
          },
          `#/googleDiscovery/${input.operation.providerData.toolId}/call`,
        );

  mutableRecord(input.catalog.executables)[executableId] = {
    id: executableId,
    capabilityId,
    scopeId: input.serviceScopeId,
    pluginKey: GOOGLE_DISCOVERY_SOURCE_KIND,
    bindingVersion: EXECUTABLE_BINDING_VERSION,
    binding: input.operation.providerData,
    projection: {
      responseSetId,
      callShapeId,
    },
    display: {
      protocol: "http",
      method: input.operation.providerData.invocation.method.toUpperCase(),
      pathTemplate: input.operation.providerData.invocation.path,
      operationId: input.operation.providerData.methodId,
      group: input.operation.providerData.group,
      leaf: input.operation.providerData.leaf,
      rawToolId: input.operation.providerData.rawToolId,
      title: input.operation.title ?? null,
      summary: input.operation.description ?? null,
    },
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/googleDiscovery/${input.operation.providerData.toolId}/executable`,
    ),
  } satisfies Executable;

  const effect = input.operation.effect;
  const auth: AuthRequirement = authSchemeId
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
      ...(input.operation.description
        ? { summary: input.operation.description }
        : {}),
      tags: [
        "google",
        input.operation.providerData.service,
        input.operation.providerData.version,
      ],
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
    provenance: provenanceFor(
      input.documentId,
      `#/googleDiscovery/${input.operation.providerData.toolId}/capability`,
    ),
  } satisfies Capability;
};

export const createGoogleDiscoveryCatalogFragment = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly GoogleDiscoveryCatalogOperationInput[];
}) =>
  buildCatalogFragment({
    source: input.source,
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

export const createGoogleDiscoveryCatalogSnapshot = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly GoogleDiscoveryCatalogOperationInput[];
}): CatalogSnapshotV1 =>
  createCatalogSnapshotV1FromFragments({
    import: createCatalogImportMetadata({
      source: input.source,
      pluginKey: GOOGLE_DISCOVERY_SOURCE_KIND,
    }),
    fragments: [createGoogleDiscoveryCatalogFragment(input)],
  });
