import {
  CapabilityIdSchema,
  DocumentIdSchema,
  ExampleSymbolIdSchema,
  ExecutableIdSchema,
  HeaderSymbolIdSchema,
  ParameterSymbolIdSchema,
  RequestBodySymbolIdSchema,
  ResponseSymbolIdSchema,
  ScopeIdSchema,
  SecuritySchemeSymbolIdSchema,
} from "@executor/ir/ids";
import type {
  AuthRequirement,
  Capability,
  ContentSpec,
  Executable,
  ParameterSymbol,
  ResponseSet,
  ResponseSymbol,
  Scope,
  SecuritySchemeSymbol,
} from "@executor/ir/model";
import {
  EXECUTABLE_BINDING_VERSION,
  buildCatalogFragment,
  docsFrom,
  exampleSymbolFromValue,
  groupedSchemaForParameter,
  interactionForEffect,
  mutableRecord,
  preferredResponseContentTypes,
  provenanceFor,
  requestBodySchemaFromInput,
  responseSetFromSingleResponse,
  responseSetFromVariants,
  stableHash,
  statusMatchFromHttpStatusCode,
  toolPathSegments,
  type BaseCatalogOperationInput,
  type CatalogFragmentBuilder,
  type CatalogSourceDocumentInput,
  type JsonSchemaImporter,
  type Source,
} from "@executor/source-core";

import type {
  OpenApiHeader,
  OpenApiMediaContent,
  OpenApiSecurityRequirement,
  OpenApiSecurityScheme,
  OpenApiExecutableBinding,
  OpenApiToolProviderData,
  OpenApiToolDefinition,
} from "./types";
import { openApiProviderDataFromDefinition } from "./definitions";
import { parseOpenApiDocument } from "./document";

export type OpenApiCatalogOperationInput = BaseCatalogOperationInput & {
  providerData: OpenApiToolProviderData;
};

const openApiServerSpecs = (
  servers:
    | OpenApiToolProviderData["servers"]
    | OpenApiToolProviderData["documentServers"]
    | undefined,
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

const createOperationScope = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "id">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  parentScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: OpenApiCatalogOperationInput;
  defaults: Scope["defaults"];
}) => {
  const scopeId = ScopeIdSchema.make(
    `scope_${stableHash({
      sourceId: input.source.id,
      toolId: input.operation.providerData.toolId,
      kind: "operation",
    })}`,
  );

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
    provenance: provenanceFor(
      input.documentId,
      `#/openapi/${input.operation.providerData.toolId}/scope`,
    ),
  } satisfies Scope;

  return scopeId;
};

const ensureOpenApiSecuritySchemeSymbol = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "id">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  schemeName: string;
  scheme?: OpenApiSecurityScheme;
}) => {
  const schemeId = SecuritySchemeSymbolIdSchema.make(
    `security_${stableHash({
      sourceId: input.source.id,
      provider: "openapi",
      schemeName: input.schemeName,
    })}`,
  );

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
  const description =
    scheme?.description ??
    (scheme?.openIdConnectUrl ? `OpenID Connect: ${scheme.openIdConnectUrl}` : null);

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
    ...(scheme?.placementIn || scheme?.placementName
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
    ...((schemeType === "basic" || schemeType === "bearer" || schemeType === "http") &&
    scheme?.scheme
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
    ...(schemeType === "custom" ? { custom: {} } : {}),
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/openapi/securitySchemes/${input.schemeName}`,
    ),
  } satisfies SecuritySchemeSymbol;

  return schemeId;
};

const openApiAuthRequirementToIr = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "id">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  authRequirement: OpenApiSecurityRequirement | undefined;
  schemesByName: ReadonlyMap<string, OpenApiSecurityScheme>;
}): AuthRequirement => {
  const requirement = input.authRequirement;
  if (!requirement) {
    return { kind: "none" };
  }

  switch (requirement.kind) {
    case "none":
      return { kind: "none" };
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
          }),
        ),
      };
  }
};

const contentSpecsFromOpenApiContents = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "kind">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  importer: JsonSchemaImporter;
  rootSchema?: unknown;
  contents: ReadonlyArray<OpenApiMediaContent>;
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
      }),
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
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "kind">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  importer: JsonSchemaImporter;
  rootSchema?: unknown;
  pointer: string;
  idSeed: Record<string, unknown>;
  header: OpenApiHeader;
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
    }),
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
    ...(typeof input.header.deprecated === "boolean"
      ? { deprecated: input.header.deprecated }
      : {}),
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
    ...(typeof input.header.explode === "boolean"
      ? { explode: input.header.explode }
      : {}),
    synthetic: false,
    provenance: provenanceFor(input.documentId, input.pointer),
  };

  return headerId;
};

const createHttpCapabilityFromOpenApi = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "id" | "kind" | "name" | "namespace">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  serviceScopeId: ReturnType<typeof ScopeIdSchema.make>;
  operation: OpenApiCatalogOperationInput;
  importer: JsonSchemaImporter;
  rootSchema?: unknown;
}) => {
  const toolPath = toolPathSegments(input.source, input.operation.providerData.toolId);
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
  const exampleIds: Array<ReturnType<typeof ExampleSymbolIdSchema.make>> = [];
  const schemesByName = new Map(
    (input.operation.providerData.securitySchemes ?? []).map((scheme) => [
      scheme.schemeName,
      scheme,
    ]),
  );

  input.operation.providerData.invocation.parameters.forEach((parameter) => {
    const parameterId = ParameterSymbolIdSchema.make(
      `param_${stableHash({
        capabilityId,
        location: parameter.location,
        name: parameter.name,
      })}`,
    );
    const parameterSchema = groupedSchemaForParameter(
      inputSchema,
      parameter.location,
      parameter.name,
    );
    const matchingDocs = input.operation.providerData.documentation?.parameters.find(
      (candidate) =>
        candidate.name === parameter.name && candidate.location === parameter.location,
    );
    const parameterExampleIds = (matchingDocs?.examples ?? []).map((example, index) =>
      exampleSymbolFromValue({
        catalog: input.catalog,
        source: input.source,
        documentId: input.documentId,
        pointer: `#/openapi/${input.operation.providerData.toolId}/parameter/${parameter.location}/${parameter.name}/example/${index}`,
        name: example.label,
        summary: example.label,
        value: JSON.parse(example.valueJson) as unknown,
      }),
    );
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
      ...(typeof parameter.allowReserved === "boolean"
        ? { allowReserved: parameter.allowReserved }
        : {}),
      synthetic: false,
      provenance: provenanceFor(
        input.documentId,
        `#/openapi/${input.operation.providerData.toolId}/parameter/${parameter.location}/${parameter.name}`,
      ),
    } satisfies ParameterSymbol;
  });

  const requestBodyId = input.operation.providerData.invocation.requestBody
    ? RequestBodySymbolIdSchema.make(`request_body_${stableHash({ capabilityId })}`)
    : undefined;

  if (requestBodyId) {
    const requestBody = input.operation.providerData.invocation.requestBody;
    const requestBodySchema = requestBodySchemaFromInput(inputSchema);
    const requestBodyContents = requestBody?.contents
      ? contentSpecsFromOpenApiContents({
          catalog: input.catalog,
          source: input.source,
          documentId: input.documentId,
          importer: input.importer,
          rootSchema: input.rootSchema,
          contents: requestBody.contents,
          pointerBase: `#/openapi/${input.operation.providerData.toolId}/requestBody`,
        })
      : undefined;
    const requestBodyExampleIds =
      requestBodyContents?.flatMap((content) => content.exampleIds ?? []) ??
      (input.operation.providerData.documentation?.requestBody?.examples ?? []).map(
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
            ...(requestBodyExampleIds.length > 0
              ? { exampleIds: requestBodyExampleIds }
              : {}),
          }));

    mutableRecord(input.catalog.symbols)[requestBodyId] = {
      id: requestBodyId,
      kind: "requestBody",
      ...(docsFrom({
        description:
          input.operation.providerData.documentation?.requestBody?.description ?? null,
      })
        ? {
            docs: docsFrom({
              description:
                input.operation.providerData.documentation?.requestBody?.description ??
                null,
            })!,
          }
        : {}),
      required: input.operation.providerData.invocation.requestBody?.required ?? false,
      contents,
      synthetic: false,
      provenance: provenanceFor(
        input.documentId,
        `#/openapi/${input.operation.providerData.toolId}/requestBody`,
      ),
    };
  }

  const openApiResponseVariants = input.operation.providerData.responses ?? [];
  const responseSetId =
    openApiResponseVariants.length > 0
      ? responseSetFromVariants({
          catalog: input.catalog,
          variants: openApiResponseVariants.map((response, responseIndex) => {
            const responseId = ResponseSymbolIdSchema.make(
              `response_${stableHash({
                capabilityId,
                statusCode: response.statusCode,
                responseIndex,
              })}`,
            );
            const responseExampleIds = (response.examples ?? []).map((example, index) =>
              exampleSymbolFromValue({
                catalog: input.catalog,
                source: input.source,
                documentId: input.documentId,
                pointer: `#/openapi/${input.operation.providerData.toolId}/responses/${response.statusCode}/example/${index}`,
                name: example.label,
                summary: example.label,
                value: JSON.parse(example.valueJson) as unknown,
              }),
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
                    const preferredContentTypes = preferredResponseContentTypes(
                      response.contentTypes,
                    );

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
              }),
            );

            mutableRecord(input.catalog.symbols)[responseId] = {
              id: responseId,
              kind: "response",
              ...(docsFrom({
                description:
                  response.description ??
                  (responseIndex === 0 ? input.operation.description : null),
              })
                ? {
                    docs: docsFrom({
                      description:
                        response.description ??
                        (responseIndex === 0 ? input.operation.description : null),
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
          provenance: provenanceFor(
            input.documentId,
            `#/openapi/${input.operation.providerData.toolId}/responseSet`,
          ),
        })
      : (() => {
          const responseId = ResponseSymbolIdSchema.make(
            `response_${stableHash({ capabilityId })}`,
          );
          const responseExampleIds = (
            input.operation.providerData.documentation?.response?.examples ?? []
          ).map((example, index) =>
            exampleSymbolFromValue({
              catalog: input.catalog,
              source: input.source,
              documentId: input.documentId,
              pointer: `#/openapi/${input.operation.providerData.toolId}/response/example/${index}`,
              name: example.label,
              summary: example.label,
              value: JSON.parse(example.valueJson) as unknown,
            }),
          );
          exampleIds.push(...responseExampleIds);
          mutableRecord(input.catalog.symbols)[responseId] = {
            id: responseId,
            kind: "response",
            ...(docsFrom({
              description:
                input.operation.providerData.documentation?.response?.description ??
                input.operation.description,
            })
              ? {
                  docs: docsFrom({
                    description:
                      input.operation.providerData.documentation?.response
                        ?.description ?? input.operation.description,
                  })!,
                }
              : {}),
            contents: [
              {
                mediaType:
                  preferredResponseContentTypes(
                    input.operation.providerData.documentation?.response?.contentTypes,
                  )[0] ?? "application/json",
                ...(input.operation.outputSchema !== undefined
                  ? {
                      shapeId: input.importer.importSchema(
                        outputSchema,
                        `#/openapi/${input.operation.providerData.toolId}/response`,
                        input.rootSchema,
                      ),
                    }
                  : {}),
                ...(responseExampleIds.length > 0
                  ? { exampleIds: responseExampleIds }
                  : {}),
              },
            ],
            synthetic: false,
            provenance: provenanceFor(
              input.documentId,
              `#/openapi/${input.operation.providerData.toolId}/response`,
            ),
          } satisfies ResponseSymbol;

          return responseSetFromSingleResponse({
            catalog: input.catalog,
            responseId,
            provenance: provenanceFor(
              input.documentId,
              `#/openapi/${input.operation.providerData.toolId}/responseSet`,
            ),
          });
        })();

  const callShapeId =
    input.operation.inputSchema !== undefined
      ? input.importer.importSchema(
          input.operation.inputSchema,
          `#/openapi/${input.operation.providerData.toolId}/call`,
          input.rootSchema,
        )
      : input.importer.importSchema(
          {
            type: "object",
            additionalProperties: false,
          },
          `#/openapi/${input.operation.providerData.toolId}/call`,
        );

  const executable: Executable = {
    id: executableId,
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
    pluginKey: "openapi",
    bindingVersion: EXECUTABLE_BINDING_VERSION,
    binding: {
      kind: "openapi",
      toolId: input.operation.providerData.toolId,
      ...(input.operation.providerData.operationId
        ? { operationId: input.operation.providerData.operationId }
        : {}),
      invocation: input.operation.providerData.invocation,
      ...(input.operation.providerData.documentServers
        ? { documentServers: input.operation.providerData.documentServers }
        : {}),
      ...(input.operation.providerData.servers
        ? { servers: input.operation.providerData.servers }
        : {}),
    } satisfies OpenApiExecutableBinding,
    projection: {
      responseSetId,
      callShapeId,
    },
    display: {
      protocol: "http",
      method: input.operation.providerData.invocation.method.toUpperCase(),
      pathTemplate: input.operation.providerData.invocation.pathTemplate,
      operationId: input.operation.providerData.operationId ?? null,
      group: input.operation.providerData.group,
      leaf: input.operation.providerData.leaf,
      rawToolId: input.operation.providerData.rawToolId,
      title: input.operation.title ?? null,
      summary: input.operation.description ?? null,
    },
    synthetic: false,
    provenance: provenanceFor(
      input.documentId,
      `#/openapi/${input.operation.providerData.toolId}/executable`,
    ),
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
      ...(input.operation.providerData.tags.length > 0
        ? { tags: input.operation.providerData.tags }
        : {}),
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
    provenance: provenanceFor(
      input.documentId,
      `#/openapi/${input.operation.providerData.toolId}/capability`,
    ),
  } satisfies Capability;
};

export const openApiCatalogOperationFromDefinition = (definition: OpenApiToolDefinition) => {
  const providerData = openApiProviderDataFromDefinition(definition);
  const method = definition.method.toUpperCase();

  return {
    toolId: definition.toolId,
    title: definition.name,
    description: definition.description,
    effect:
      method === "GET" || method === "HEAD"
        ? "read"
        : method === "DELETE"
          ? "delete"
          : "write",
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    providerData,
  } satisfies OpenApiCatalogOperationInput;
};

export const createOpenApiCatalogFragment = (input: {
  source: Source;
  documents: readonly CatalogSourceDocumentInput[];
  operations: readonly OpenApiCatalogOperationInput[];
}) => {
  const rootSchema = (() => {
    const primaryDocumentText = input.documents[0]?.contentText;
    if (!primaryDocumentText) {
      return undefined;
    }

    try {
      return parseOpenApiDocument(primaryDocumentText);
    } catch {
      return undefined;
    }
  })();

  return buildCatalogFragment({
    source: input.source,
    documents: input.documents,
    resourceDialectUri: "https://json-schema.org/draft/2020-12/schema",
    serviceScopeDefaults: (() => {
      const documentServers = openApiServerSpecs(
        input.operations.find(
          (operation) => (operation.providerData.documentServers ?? []).length > 0,
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
