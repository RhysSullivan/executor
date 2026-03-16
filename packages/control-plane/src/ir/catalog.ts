import { sha256Hex } from "@executor/codemode-core";
import * as ParseResult from "effect/ParseResult";
import { Schema } from "effect";

import {
  CapabilityIdSchema,
  type CapabilityId,
  DiagnosticIdSchema,
  type DiagnosticId,
  DocumentIdSchema,
  type DocumentId,
  ExecutableIdSchema,
  type ExecutableId,
  ExampleSymbolIdSchema,
  type ExampleSymbolId,
  HeaderSymbolIdSchema,
  type HeaderSymbolId,
  ParameterSymbolIdSchema,
  type ParameterSymbolId,
  type RequestBodySymbolId,
  ResourceIdSchema,
  type ResourceId,
  type ResponseSymbolId,
  type ResponseSetId,
  ScopeIdSchema,
  type ScopeId,
  type ShapeSymbolId,
  ShapeSymbolIdSchema,
  type SymbolId,
} from "./ids";
import {
  CatalogFragmentV1Schema,
  type CatalogFragmentV1,
  CatalogSnapshotV1Schema,
  CatalogV1Schema,
  type CatalogV1,
  type Capability,
  type ContentSpec,
  type DocumentationBlock,
  type Executable,
  type GraphQLExecutable,
  type HttpExecutable,
  type ImportDiagnostic,
  type ImportMetadata,
  type InteractionSpec,
  type McpExecutable,
  type ParameterSymbol,
  type HeaderSymbol,
  type ResponseSet,
  type ResponseSymbol,
  type Scope,
  type ScopeDefaults,
  type ShapeSymbol,
  type StatusMatch,
  type Symbol as IrSymbol,
} from "./model";

export interface ToolDescriptor {
  toolPath: string[];
  capabilityId: CapabilityId;
  title?: string;
  summary?: string;
  effect: Capability["semantics"]["effect"];
  interaction: {
    mayRequireApproval: boolean;
    mayElicit: boolean;
  };
  callShapeId: ShapeSymbolId;
  resultShapeId?: ShapeSymbolId;
  responseSetId: ResponseSetId;
  diagnosticCounts: {
    warning: number;
    error: number;
  };
}

export interface ToolSearchDoc {
  capabilityId: CapabilityId;
  toolPath: string[];
  title?: string;
  summary?: string;
  tags?: string[];
  protocolHints: string[];
  authHints: string[];
  effect: Capability["semantics"]["effect"];
}

export interface CapabilitySummaryView {
  capabilityId: CapabilityId;
  toolPath: string[];
  summary?: string;
  executableIds: ExecutableId[];
  auth: Capability["auth"];
  interaction: InteractionSpec;
  callShapeId: ShapeSymbolId;
  resultShapeId?: ShapeSymbolId;
  responseSetId: ResponseSetId;
  diagnosticIds?: DiagnosticId[];
}

export interface SymbolShallowView {
  symbolId: SymbolId;
  kind: IrSymbol["kind"];
  title?: string;
  summary?: string;
  edges: Array<{ label: string; targetId: SymbolId }>;
}

export interface SymbolExpandedView {
  symbolId: SymbolId;
  symbol: IrSymbol;
  diagnostics?: ImportDiagnostic[];
}

export interface InvocationPlan {
  capabilityId: CapabilityId;
  executableId: ExecutableId;
  connectionBindingId: string;
  resolvedScopeChain: ScopeId[];
  resolvedEndpoint?: string;
  resolvedAuth?: unknown;
  resolvedInteraction?: {
    requiresApproval: boolean;
    mayPauseForElicitation: boolean;
    resumable: boolean;
  };
  requestPlan: unknown;
  provenance: CatalogV1["capabilities"][CapabilityId]["provenance"];
}

export interface ProjectedCatalog {
  catalog: CatalogV1;
  toolDescriptors: Record<CapabilityId, ToolDescriptor>;
  searchDocs: Record<CapabilityId, ToolSearchDoc>;
  capabilityViews: Record<CapabilityId, CapabilitySummaryView>;
}

export interface CatalogInvariantViolation {
  code:
    | "missing_symbol_provenance"
    | "missing_entity_provenance"
    | "missing_document"
    | "missing_provenance_document"
    | "missing_resource_context"
    | "missing_reference_target"
    | "missing_unresolved_ref_diagnostic"
    | "missing_executable"
    | "missing_response_set"
    | "missing_scope"
    | "missing_service_scope"
    | "invalid_preferred_executable"
    | "missing_projection_synthetic_marker";
  message: string;
  entityId?: string;
}

export type DecodeCatalogError = Error;

type MutableScopeDefaults = {
  servers?: ScopeDefaults["servers"];
  auth?: ScopeDefaults["auth"];
  parameterIds?: ParameterSymbolId[];
  headerIds?: HeaderSymbolId[];
  variables?: Record<string, string>;
};

type CatalogSnapshotV1 = {
  version: "ir.v1.snapshot";
  import: ImportMetadata;
  catalog: CatalogV1;
};

const decodeCatalogSync = Schema.decodeUnknownSync(
  CatalogV1Schema as Schema.Schema<CatalogV1, unknown, never>,
);
const decodeCatalogSnapshotSync = Schema.decodeUnknownSync(
  CatalogSnapshotV1Schema as Schema.Schema<CatalogSnapshotV1, unknown, never>,
);
const decodeCatalogFragmentSync = Schema.decodeUnknownSync(
  CatalogFragmentV1Schema as Schema.Schema<CatalogFragmentV1, unknown, never>,
);

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

const stableHash = (value: unknown): string => sha256Hex(stableStringify(value)).slice(0, 16);

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const cloneCatalog = (catalog: CatalogV1): CatalogV1 => ({
  version: catalog.version,
  documents: { ...catalog.documents },
  resources: { ...catalog.resources },
  scopes: { ...catalog.scopes },
  symbols: { ...catalog.symbols },
  capabilities: { ...catalog.capabilities },
  executables: { ...catalog.executables },
  responseSets: { ...catalog.responseSets },
  diagnostics: { ...catalog.diagnostics },
});

const mutableRecord = <K extends string, V>(value: Readonly<Record<K, V>>): Record<K, V> =>
  value as unknown as Record<K, V>;

const createStableEntityId = <A extends string>(
  make: (value: string) => A,
  prefix: string,
  value: unknown,
): A => make(`${prefix}_${stableHash(value)}`);

const emptyCatalog = (): CatalogV1 => ({
  version: "ir.v1",
  documents: {},
  resources: {},
  scopes: {},
  symbols: {},
  capabilities: {},
  executables: {},
  responseSets: {},
  diagnostics: {},
});

const authHintStrings = (catalog: CatalogV1, auth: Capability["auth"]): string[] => {
  switch (auth.kind) {
    case "none":
      return ["none"];
    case "scheme": {
      const scheme = catalog.symbols[auth.schemeId];
      if (!scheme || scheme.kind !== "securityScheme") {
        return ["unknown"];
      }
      return [
        scheme.schemeType,
        ...((auth.scopes ?? []).map((scope: string) => `scope:${scope}`)),
      ];
    }
    case "allOf":
    case "anyOf":
      return unique(auth.items.flatMap((item: Capability["auth"]) => authHintStrings(catalog, item)));
  }
};

const docsSummary = (docs: DocumentationBlock | undefined): string | undefined =>
  docs?.summary ?? docs?.description;

const getShape = (catalog: CatalogV1, shapeId: ShapeSymbolId): ShapeSymbol | undefined => {
  const symbol = catalog.symbols[shapeId];
  return symbol && symbol.kind === "shape" ? symbol : undefined;
};

const getParameter = (
  catalog: CatalogV1,
  parameterId: ParameterSymbolId,
): ParameterSymbol | undefined => {
  const symbol = catalog.symbols[parameterId];
  return symbol && symbol.kind === "parameter" ? symbol : undefined;
};

const getResponseSymbol = (
  catalog: CatalogV1,
  responseId: ResponseSymbolId,
): ResponseSymbol | undefined => {
  const symbol = catalog.symbols[responseId];
  return symbol && symbol.kind === "response" ? symbol : undefined;
};

const getHeader = (
  catalog: CatalogV1,
  headerId: HeaderSymbolId,
): HeaderSymbol | undefined => {
  const symbol = catalog.symbols[headerId];
  return symbol && symbol.kind === "header" ? symbol : undefined;
};

const scopeChain = (catalog: CatalogV1, scopeId: ScopeId): Scope[] => {
  const chain: Scope[] = [];
  let currentId: ScopeId | undefined = scopeId;

  while (currentId) {
    const scope: Scope | undefined = catalog.scopes[currentId];
    if (!scope) {
      break;
    }
    chain.unshift(scope);
    currentId = scope.parentId;
  }

  return chain;
};

const mergeScopeDefaults = (chain: readonly Scope[]): ScopeDefaults => {
  const merged: MutableScopeDefaults = {};

  for (const scope of chain) {
    const defaults = scope.defaults;
    if (!defaults) {
      continue;
    }

    if (defaults.servers) {
      merged.servers = [...defaults.servers];
    }

    if (defaults.auth) {
      merged.auth = defaults.auth;
    }

    if (defaults.parameterIds) {
      merged.parameterIds = unique([
        ...(merged.parameterIds ?? []),
        ...defaults.parameterIds,
      ]);
    }

    if (defaults.headerIds) {
      merged.headerIds = unique([
        ...(merged.headerIds ?? []),
        ...defaults.headerIds,
      ]);
    }

    if (defaults.variables) {
      merged.variables = {
        ...(merged.variables ?? {}),
        ...defaults.variables,
      };
    }
  }

  return merged as ScopeDefaults;
};

const isJsonMediaType = (mediaType: string): boolean => {
  const normalized = mediaType.trim().toLowerCase();
  return normalized === "application/json"
    || normalized.endsWith("+json")
    || normalized === "text/json";
};

const createDiagnostic = (
  catalog: CatalogV1,
  input: Omit<ImportDiagnostic, "id"> & { idSeed: unknown },
): DiagnosticId => {
  const diagnosticId = createStableEntityId(
    DiagnosticIdSchema.make,
    "diag",
    input.idSeed,
  );

  mutableRecord(catalog.diagnostics)[diagnosticId] = {
    id: diagnosticId,
    level: input.level,
    code: input.code,
    message: input.message,
    ...(input.relatedSymbolIds ? { relatedSymbolIds: input.relatedSymbolIds } : {}),
    provenance: input.provenance,
  };

  return diagnosticId;
};

const ensureProjectionResource = (
  catalog: CatalogV1,
  capability: Capability,
): ResourceId => {
  const resourceId = createStableEntityId(
    ResourceIdSchema.make,
    "res",
    {
      kind: "projection",
      capabilityId: capability.id,
    },
  );

  if (!catalog.resources[resourceId]) {
    const serviceScope = catalog.scopes[capability.serviceScopeId];
    const documentId = serviceScope?.provenance[0]?.documentId
      ?? DocumentIdSchema.make(`doc_projection_${stableHash(capability.id)}`);

    if (!catalog.documents[documentId]) {
      mutableRecord(catalog.documents)[documentId] = {
        id: documentId,
        kind: "custom",
        title: `Projection resource for ${capability.id}`,
        fetchedAt: new Date(0).toISOString(),
        rawRef: `synthetic://projection/${capability.id}`,
      };
    }

    mutableRecord(catalog.resources)[resourceId] = {
      id: resourceId,
      documentId,
      canonicalUri: `synthetic://projection/${capability.id}`,
      baseUri: `synthetic://projection/${capability.id}`,
      anchors: {},
      dynamicAnchors: {},
      synthetic: true,
      provenance: capability.provenance,
    };

    createDiagnostic(catalog, {
      idSeed: {
        code: "synthetic_resource_context_created",
        capabilityId: capability.id,
      },
      level: "info",
      code: "synthetic_resource_context_created",
      message: `Created synthetic projection resource for ${capability.id}`,
      provenance: capability.provenance,
    });
  }

  return resourceId;
};

const createSyntheticShape = (
  catalog: CatalogV1,
  input: {
    capability: Capability;
    label: string;
    node: ShapeSymbol["node"];
    title?: string;
    docs?: DocumentationBlock;
    diagnostic?:
      | {
          level: ImportDiagnostic["level"];
          code: ImportDiagnostic["code"];
          message: string;
          relatedSymbolIds?: SymbolId[];
        }
      | undefined;
  },
): ShapeSymbolId => {
  const resourceId = ensureProjectionResource(catalog, input.capability);
  const shapeId = createStableEntityId(
    ShapeSymbolIdSchema.make,
    "shape",
    {
      capabilityId: input.capability.id,
      label: input.label,
      node: input.node,
    },
  );

  if (!catalog.symbols[shapeId]) {
    const diagnostics = input.diagnostic
      ? [
          createDiagnostic(catalog, {
            idSeed: {
              code: input.diagnostic.code,
              shapeId,
            },
            level: input.diagnostic.level,
            code: input.diagnostic.code,
            message: input.diagnostic.message,
            ...(input.diagnostic.relatedSymbolIds
              ? { relatedSymbolIds: input.diagnostic.relatedSymbolIds }
              : {}),
            provenance: input.capability.provenance,
          }),
        ]
      : undefined;

    mutableRecord(catalog.symbols)[shapeId] = {
      id: shapeId,
      kind: "shape",
      resourceId,
      ...(input.title ? { title: input.title } : {}),
      ...(input.docs ? { docs: input.docs } : {}),
      node: input.node,
      synthetic: true,
      provenance: input.capability.provenance,
      ...(diagnostics ? { diagnosticIds: diagnostics } : {}),
    };
  }

  return shapeId;
};

const contentShapeId = (
  catalog: CatalogV1,
  capability: Capability,
  contents: readonly ContentSpec[] | undefined,
  label: string,
): ShapeSymbolId | undefined => {
  const shapeIds = unique(
    (contents ?? [])
      .map((content) => content.shapeId)
      .filter((shapeId): shapeId is ShapeSymbolId => shapeId !== undefined),
  );

  if (shapeIds.length === 0) {
    return undefined;
  }

  if (shapeIds.length === 1) {
    return shapeIds[0];
  }

  return createSyntheticShape(catalog, {
    capability,
    label,
    title: `${capability.surface.title ?? capability.id} content union`,
    node: {
      type: "anyOf",
      items: shapeIds,
    },
    diagnostic: {
      level: "warning",
      code: "projection_result_shape_synthesized",
      message: `Synthesized content union for ${capability.id}`,
      relatedSymbolIds: shapeIds,
    },
  });
};

const parameterShapeId = (
  catalog: CatalogV1,
  capability: Capability,
  parameter: ParameterSymbol,
): ShapeSymbolId => {
  if (parameter.schemaShapeId) {
    return parameter.schemaShapeId;
  }

  const contentShape = contentShapeId(
    catalog,
    capability,
    parameter.content,
    `parameter:${parameter.id}`,
  );
  if (contentShape) {
    return contentShape;
  }

  return createSyntheticShape(catalog, {
    capability,
    label: `parameter:${parameter.id}:unknown`,
    title: parameter.name,
    docs: parameter.docs,
    node: {
      type: "unknown",
      reason: `Missing shape for parameter ${parameter.id}`,
    },
    diagnostic: {
      level: "warning",
      code: "projection_call_shape_synthesized",
      message: `Missing parameter shape for ${parameter.name}; using unknown`,
      relatedSymbolIds: [parameter.id],
    },
  });
};

const requestBodyShapeId = (
  catalog: CatalogV1,
  capability: Capability,
  requestBodyId: RequestBodySymbolId | undefined,
): ShapeSymbolId | undefined => {
  if (!requestBodyId) {
    return undefined;
  }

  const requestBody = catalog.symbols[requestBodyId];
  if (!requestBody || requestBody.kind !== "requestBody") {
    return undefined;
  }

  return contentShapeId(
    catalog,
    capability,
    requestBody.contents,
    `requestBody:${requestBody.id}`,
  );
};

const chooseExecutable = (catalog: CatalogV1, capability: Capability): Executable => {
  const preferredId = capability.preferredExecutableId;
  if (preferredId) {
    const preferred = catalog.executables[preferredId];
    if (preferred) {
      return preferred;
    }
  }

  const executables = capability.executableIds
    .map((executableId) => catalog.executables[executableId])
    .filter((executable): executable is Executable => executable !== undefined);

  if (executables.length === 0) {
    throw new Error(`Capability ${capability.id} has no executables`);
  }

  return executables[0];
};

const scoreStatusMatch = (match: StatusMatch): number => {
  switch (match.kind) {
    case "exact":
      return match.status === 200 ? 100 : match.status >= 200 && match.status < 300 ? 80 : 10;
    case "range":
      return match.value === "2XX" ? 60 : 5;
    case "default":
      return 40;
  }
};

const responseContentCandidates = (
  response: ResponseSymbol,
): Array<{ mediaType: string; shapeId: ShapeSymbolId }> =>
  (response.contents ?? [])
    .flatMap((content) =>
      content.shapeId ? [{ mediaType: content.mediaType, shapeId: content.shapeId }] : [],
    );

type RankedResponseVariantEntry = {
  variant: ResponseSet["variants"][number];
  response: ResponseSymbol;
  score: number;
};

const responseVariantEntries = (
  catalog: CatalogV1,
  responseSet: ResponseSet,
): RankedResponseVariantEntry[] =>
  [...responseSet.variants]
    .map((variant) => {
      const response = getResponseSymbol(catalog, variant.responseId);
      return response
        ? {
            variant,
            response,
            score: scoreStatusMatch(variant.match),
          }
        : null;
    })
    .filter((entry): entry is RankedResponseVariantEntry => entry !== null);

const isSuccessStatusMatch = (match: StatusMatch): boolean => {
  switch (match.kind) {
    case "exact":
      return match.status >= 200 && match.status < 300;
    case "range":
      return match.value === "2XX";
    case "default":
      return false;
  }
};

const contentShapeIdFromResponseEntries = (
  catalog: CatalogV1,
  capability: Capability,
  label: string,
  title: string,
  entries: readonly RankedResponseVariantEntry[],
): ShapeSymbolId | undefined => {
  const jsonCandidates = entries.flatMap(({ response }) =>
    responseContentCandidates(response).filter((candidate) => isJsonMediaType(candidate.mediaType)),
  );

  if (jsonCandidates.length > 0) {
    return contentShapeId(
      catalog,
      capability,
      jsonCandidates.map((candidate) => ({
        mediaType: candidate.mediaType,
        shapeId: candidate.shapeId,
      })),
      `${label}:json`,
    );
  }

  const fallbackShapeIds = unique(
    entries.flatMap(({ response }) =>
      responseContentCandidates(response).map((candidate) => candidate.shapeId),
    ),
  );

  if (fallbackShapeIds.length === 0) {
    return undefined;
  }

  if (fallbackShapeIds.length === 1) {
    return fallbackShapeIds[0];
  }

  return createSyntheticShape(catalog, {
    capability,
    label: `${label}:union`,
    title,
    node: {
      type: "anyOf",
      items: fallbackShapeIds,
    },
    diagnostic: {
      level: "warning",
      code: "multi_response_union_synthesized",
      message: `Synthesized response union for ${capability.id}`,
      relatedSymbolIds: fallbackShapeIds,
    },
  });
};

const projectResultShapeFromResponses = (
  catalog: CatalogV1,
  capability: Capability,
  responseSet: ResponseSet,
): ShapeSymbolId | undefined =>
  contentShapeIdFromResponseEntries(
    catalog,
    capability,
    `responseSet:${responseSet.id}`,
    `${capability.surface.title ?? capability.id} result`,
    responseVariantEntries(catalog, responseSet).filter(({ variant }) => isSuccessStatusMatch(variant.match)),
  );

const projectErrorShapeFromResponses = (
  catalog: CatalogV1,
  capability: Capability,
  responseSet: ResponseSet,
): ShapeSymbolId | undefined =>
  contentShapeIdFromResponseEntries(
    catalog,
    capability,
    `responseSet:${responseSet.id}:error`,
    `${capability.surface.title ?? capability.id} error`,
    responseVariantEntries(catalog, responseSet).filter(({ variant }) => !isSuccessStatusMatch(variant.match)),
  );

const scalarShape = (
  catalog: CatalogV1,
  capability: Capability,
  input: {
    label: string;
    title: string;
    scalar: "string" | "number" | "integer" | "boolean" | "null" | "bytes";
  },
): ShapeSymbolId =>
  createSyntheticShape(catalog, {
    capability,
    label: input.label,
    title: input.title,
    node: {
      type: "scalar",
      scalar: input.scalar,
    },
  });

const constNullShape = (
  catalog: CatalogV1,
  capability: Capability,
  label: string,
): ShapeSymbolId =>
  createSyntheticShape(catalog, {
    capability,
    label,
    title: "null",
    node: {
      type: "const",
      value: null,
    },
  });

const unknownShape = (
  catalog: CatalogV1,
  capability: Capability,
  input: {
    label: string;
    title: string;
    reason: string;
  },
): ShapeSymbolId =>
  createSyntheticShape(catalog, {
    capability,
    label: input.label,
    title: input.title,
    node: {
      type: "unknown",
      reason: input.reason,
    },
  });

const nullableShape = (
  catalog: CatalogV1,
  capability: Capability,
  input: {
    label: string;
    title: string;
    baseShapeId: ShapeSymbolId;
  },
): ShapeSymbolId => {
  const nullShapeId = constNullShape(catalog, capability, `${input.label}:null`);
  if (input.baseShapeId === nullShapeId) {
    return nullShapeId;
  }

  return createSyntheticShape(catalog, {
    capability,
    label: `${input.label}:nullable`,
    title: input.title,
    node: {
      type: "anyOf",
      items: unique([input.baseShapeId, nullShapeId]),
    },
  });
};

const headersShape = (
  catalog: CatalogV1,
  capability: Capability,
  label: string,
): ShapeSymbolId => {
  const valueShapeId = scalarShape(catalog, capability, {
    label: `${label}:value`,
    title: "Header value",
    scalar: "string",
  });

  return createSyntheticShape(catalog, {
    capability,
    label,
    title: "Response headers",
    node: {
      type: "object",
      fields: {},
      additionalProperties: valueShapeId,
    },
  });
};

const shapeFieldShapeId = (
  catalog: CatalogV1,
  shapeId: ShapeSymbolId | undefined,
  fieldName: string,
  seen = new Set<ShapeSymbolId>(),
): ShapeSymbolId | undefined => {
  if (!shapeId || seen.has(shapeId)) {
    return undefined;
  }

  const shape = getShape(catalog, shapeId);
  if (!shape) {
    return undefined;
  }

  const nextSeen = new Set(seen);
  nextSeen.add(shapeId);

  switch (shape.node.type) {
    case "ref":
      return shapeFieldShapeId(catalog, shape.node.target, fieldName, nextSeen);
    case "object":
      return shape.node.fields[fieldName]?.shapeId;
    case "allOf":
      for (const item of shape.node.items) {
        const found = shapeFieldShapeId(catalog, item, fieldName, nextSeen);
        if (found) {
          return found;
        }
      }
      return undefined;
    default:
      return undefined;
  }
};

const projectExecutionResultShape = (
  catalog: CatalogV1,
  capability: Capability,
  executable: Executable,
  responseSet: ResponseSet,
): ShapeSymbolId => {
  const genericDataShape = unknownShape(catalog, capability, {
    label: `executionResult:${capability.id}:data:unknown`,
    title: "Response data",
    reason: `Execution result data for ${capability.id} is not statically known`,
  });
  const genericErrorShape = unknownShape(catalog, capability, {
    label: `executionResult:${capability.id}:error:unknown`,
    title: "Response error",
    reason: `Execution result error for ${capability.id} is not statically known`,
  });
  const genericHeadersShape = headersShape(
    catalog,
    capability,
    `executionResult:${capability.id}:headers`,
  );
  const genericStatusShape = scalarShape(catalog, capability, {
    label: `executionResult:${capability.id}:status`,
    title: "Response status",
    scalar: "integer",
  });

  let dataShapeId: ShapeSymbolId | undefined;
  let errorShapeId: ShapeSymbolId | undefined;
  let headersShapeId: ShapeSymbolId = genericHeadersShape;
  let statusShapeId: ShapeSymbolId = genericStatusShape;

  switch (executable.protocol) {
    case "http":
      dataShapeId = projectResultShapeFromResponses(catalog, capability, responseSet);
      errorShapeId = projectErrorShapeFromResponses(catalog, capability, responseSet);
      break;
    case "graphql":
      dataShapeId =
        shapeFieldShapeId(catalog, executable.resultShapeId, "data")
        ?? shapeFieldShapeId(catalog, executable.resultShapeId, "body")
        ?? executable.resultShapeId;
      errorShapeId =
        shapeFieldShapeId(catalog, executable.resultShapeId, "error")
        ?? shapeFieldShapeId(catalog, executable.resultShapeId, "errors");
      headersShapeId =
        shapeFieldShapeId(catalog, executable.resultShapeId, "headers")
        ?? genericHeadersShape;
      statusShapeId =
        shapeFieldShapeId(catalog, executable.resultShapeId, "status")
        ?? genericStatusShape;
      break;
    case "mcp":
      dataShapeId = executable.outputShapeId;
      errorShapeId = undefined;
      statusShapeId = constNullShape(
        catalog,
        capability,
        `executionResult:${capability.id}:status:null`,
      );
      break;
  }

  const dataFieldShapeId = nullableShape(catalog, capability, {
    label: `executionResult:${capability.id}:data`,
    title: "Result data",
    baseShapeId: dataShapeId ?? genericDataShape,
  });
  const errorFieldShapeId = nullableShape(catalog, capability, {
    label: `executionResult:${capability.id}:error`,
    title: "Result error",
    baseShapeId: errorShapeId ?? genericErrorShape,
  });
  const statusFieldShapeId = nullableShape(catalog, capability, {
    label: `executionResult:${capability.id}:status`,
    title: "Result status",
    baseShapeId: statusShapeId,
  });

  return createSyntheticShape(catalog, {
    capability,
    label: `executionResult:${capability.id}`,
    title: `${capability.surface.title ?? capability.id} result`,
    node: {
      type: "object",
      fields: {
        data: {
          shapeId: dataFieldShapeId,
          docs: {
            description: "Successful result payload when available.",
          },
        },
        error: {
          shapeId: errorFieldShapeId,
          docs: {
            description: "Error payload when the remote execution completed but failed.",
          },
        },
        headers: {
          shapeId: headersShapeId,
          docs: {
            description: "Response headers when available.",
          },
        },
        status: {
          shapeId: statusFieldShapeId,
          docs: {
            description: "Transport status code when available.",
          },
        },
      },
      required: ["data", "error", "headers", "status"],
      additionalProperties: false,
    },
    diagnostic: {
      level: "info",
      code: "projection_result_shape_synthesized",
      message: `Synthesized execution result envelope for ${capability.id}`,
      relatedSymbolIds: unique([
        dataFieldShapeId,
        errorFieldShapeId,
        headersShapeId,
        statusFieldShapeId,
      ]),
    },
  });
};

const groupFieldShape = (
  catalog: CatalogV1,
  capability: Capability,
  location: "path" | "query" | "headers" | "cookies",
  fields: Record<string, { shapeId: ShapeSymbolId; docs?: DocumentationBlock }>,
  required: string[],
): ShapeSymbolId =>
  createSyntheticShape(catalog, {
    capability,
    label: `group:${capability.id}:${location}`,
    title: `${location} parameters`,
    node: {
      type: "object",
      fields: Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          {
            shapeId: field.shapeId,
            ...(field.docs ? { docs: field.docs } : {}),
          },
        ]),
      ),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
  });

const projectHttpCallShape = (
  catalog: CatalogV1,
  capability: Capability,
  executable: HttpExecutable,
): ShapeSymbolId => {
  const chain = scopeChain(catalog, executable.scopeId);
  const defaults = mergeScopeDefaults(chain);

  const byLocation: Record<
    "path" | "query" | "header" | "cookie",
    ParameterSymbol[]
  > = {
    path: [],
    query: [],
    header: [],
    cookie: [],
  };

  const pushParameter = (parameterId: ParameterSymbolId) => {
    const parameter = getParameter(catalog, parameterId);
    if (parameter) {
      byLocation[parameter.location].push(parameter);
    }
  };

  for (const parameterId of defaults.parameterIds ?? []) {
    pushParameter(parameterId);
  }
  for (const parameterId of executable.pathParameterIds ?? []) {
    pushParameter(parameterId);
  }
  for (const parameterId of executable.queryParameterIds ?? []) {
    pushParameter(parameterId);
  }
  for (const parameterId of executable.headerParameterIds ?? []) {
    pushParameter(parameterId);
  }
  for (const parameterId of executable.cookieParameterIds ?? []) {
    pushParameter(parameterId);
  }

  const explicitHeaders = unique([
    ...(defaults.headerIds ?? []),
  ])
    .map((headerId: HeaderSymbolId) => getHeader(catalog, headerId))
    .filter((symbol): symbol is HeaderSymbol => symbol !== undefined);

  const reservedTopLevel = new Set(["body", "args", "select", "path", "query", "headers", "cookies"]);
  const allNames = [
    ...byLocation.path.map((parameter) => parameter.name),
    ...byLocation.query.map((parameter) => parameter.name),
    ...byLocation.header.map((parameter) => parameter.name),
    ...byLocation.cookie.map((parameter) => parameter.name),
  ];

  const hasCollision = allNames.some((name, index) =>
    reservedTopLevel.has(name) || allNames.indexOf(name) !== index
  );

  const topLevelFields: Record<string, { shapeId: ShapeSymbolId; docs?: DocumentationBlock }> = {};
  const topLevelRequired: string[] = [];

  const groupedFieldNames: Array<keyof typeof byLocation> = hasCollision
    ? ["path", "query", "header", "cookie"]
    : [];

  if (hasCollision) {
    createDiagnostic(catalog, {
      idSeed: {
        code: "projection_collision_grouped_fields",
        capabilityId: capability.id,
      },
      level: "info",
      code: "projection_collision_grouped_fields",
      message: `Grouped parameter fields for ${capability.id} to avoid collisions`,
      provenance: capability.provenance,
    });
  }

  for (const location of Object.keys(byLocation) as Array<keyof typeof byLocation>) {
    const parameters = byLocation[location];
    if (parameters.length === 0) {
      continue;
    }

    if (groupedFieldNames.includes(location)) {
      const groupFields: Record<string, { shapeId: ShapeSymbolId; docs?: DocumentationBlock }> = {};
      const groupRequired: string[] = [];
      for (const parameter of parameters) {
        groupFields[parameter.name] = {
          shapeId: parameterShapeId(catalog, capability, parameter),
          docs: parameter.docs,
        };
        if (parameter.required) {
          groupRequired.push(parameter.name);
        }
      }

      const groupKey = location === "header" ? "headers" : location === "cookie" ? "cookies" : location;
      topLevelFields[groupKey] = {
        shapeId: groupFieldShape(catalog, capability, groupKey, groupFields, groupRequired),
      };
      if (groupRequired.length > 0) {
        topLevelRequired.push(groupKey);
      }
      continue;
    }

    for (const parameter of parameters) {
      topLevelFields[parameter.name] = {
        shapeId: parameterShapeId(catalog, capability, parameter),
        docs: parameter.docs,
      };
      if (parameter.required) {
        topLevelRequired.push(parameter.name);
      }
    }
  }

  for (const header of explicitHeaders) {
    if (hasCollision) {
      const existing = topLevelFields.headers
        ? getShape(catalog, topLevelFields.headers.shapeId)
        : undefined;
      const fields = existing && existing.node.type === "object"
        ? ({ ...existing.node.fields } as Record<string, { shapeId: ShapeSymbolId; docs?: DocumentationBlock }>)
        : {};
      fields[header.name] = {
        shapeId: header.schemaShapeId
          ?? createSyntheticShape(catalog, {
            capability,
            label: `header:${header.id}:unknown`,
            title: header.name,
            docs: header.docs,
            node: {
              type: "unknown",
              reason: `Missing shape for header ${header.id}`,
            },
          }),
        ...(header.docs ? { docs: header.docs } : {}),
      };
      topLevelFields.headers = {
        shapeId: groupFieldShape(
          catalog,
          capability,
          "headers",
          Object.fromEntries(
            Object.entries(fields).map(([name, field]) => [name, { shapeId: field.shapeId, docs: field.docs }]),
          ),
          [],
        ),
      };
      continue;
    }

    topLevelFields[header.name] = {
      shapeId: header.schemaShapeId
        ?? createSyntheticShape(catalog, {
          capability,
          label: `header:${header.id}:unknown`,
          title: header.name,
          docs: header.docs,
          node: {
            type: "unknown",
            reason: `Missing shape for header ${header.id}`,
          },
        }),
      docs: header.docs,
    };
  }

  const bodyShapeId = requestBodyShapeId(catalog, capability, executable.requestBodyId);
  if (bodyShapeId) {
    topLevelFields.body = { shapeId: bodyShapeId };
    const requestBody = executable.requestBodyId
      ? catalog.symbols[executable.requestBodyId]
      : undefined;
    if (requestBody && requestBody.kind === "requestBody" && requestBody.required) {
      topLevelRequired.push("body");
    }
  }

  return createSyntheticShape(catalog, {
    capability,
    label: `call:${capability.id}`,
    title: `${capability.surface.title ?? capability.id} call`,
    node: {
      type: "object",
      fields: Object.fromEntries(
        Object.entries(topLevelFields).map(([name, field]) => [
          name,
          {
            shapeId: field.shapeId,
            ...(field.docs ? { docs: field.docs } : {}),
          },
        ]),
      ),
      ...(topLevelRequired.length > 0 ? { required: unique(topLevelRequired) } : {}),
      additionalProperties: false,
    },
    diagnostic: {
      level: "info",
      code: "projection_call_shape_synthesized",
      message: `Synthesized HTTP call shape for ${capability.id}`,
    },
  });
};

const projectGraphqlCallShape = (
  catalog: CatalogV1,
  capability: Capability,
  executable: GraphQLExecutable,
): ShapeSymbolId => {
  const argumentShape = getShape(catalog, executable.argumentShapeId);
  const reserved = new Set(["body", "args", "select", "path", "query", "headers", "cookies"]);

  const canFlatten =
    argumentShape?.node.type === "object"
    && Object.keys(argumentShape.node.fields).every((name) => !reserved.has(name));

  const fields: Record<string, { shapeId: ShapeSymbolId; docs?: DocumentationBlock }> = {};
  const required: string[] = [];

  if (canFlatten && argumentShape.node.type === "object") {
    for (const [name, field] of Object.entries(argumentShape.node.fields)) {
      fields[name] = {
        shapeId: field.shapeId,
        docs: field.docs,
      };
    }
    required.push(...(argumentShape.node.required ?? []));
  } else {
    fields.args = {
      shapeId: executable.argumentShapeId,
      docs: argumentShape?.docs,
    };
    required.push("args");
  }

  if (executable.selectionMode === "caller") {
    fields.select = {
      shapeId:
        executable.selectionShapeId
        ?? createSyntheticShape(catalog, {
          capability,
          label: `select:${capability.id}:unknown`,
          title: `${capability.surface.title ?? capability.id} selection`,
          node: {
            type: "unknown",
            reason: `Missing selection shape for ${capability.id}`,
          },
          diagnostic: {
            level: "warning",
            code: "selection_shape_missing",
            message: `Missing selection shape for ${capability.id}`,
          },
        }),
    };
    required.push("select");
  }

  return createSyntheticShape(catalog, {
    capability,
    label: `call:${capability.id}`,
    title: `${capability.surface.title ?? capability.id} call`,
    node: {
      type: "object",
      fields: Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          {
            shapeId: field.shapeId,
            ...(field.docs ? { docs: field.docs } : {}),
          },
        ]),
      ),
      ...(required.length > 0 ? { required: unique(required) } : {}),
      additionalProperties: false,
    },
    diagnostic: {
      level: "info",
      code: "projection_call_shape_synthesized",
      message: `Synthesized GraphQL call shape for ${capability.id}`,
    },
  });
};

const projectMcpCallShape = (
  catalog: CatalogV1,
  capability: Capability,
  executable: McpExecutable,
): ShapeSymbolId => {
  if (!executable.inputShapeId) {
    return createSyntheticShape(catalog, {
      capability,
      label: `call:${capability.id}:empty`,
      title: `${capability.surface.title ?? capability.id} call`,
      node: {
        type: "object",
        fields: {},
        additionalProperties: false,
      },
      diagnostic: {
        level: "info",
        code: "projection_call_shape_synthesized",
        message: `Synthesized empty MCP call shape for ${capability.id}`,
      },
    });
  }

  const inputShape = getShape(catalog, executable.inputShapeId);
  if (inputShape?.node.type === "object") {
    return executable.inputShapeId;
  }

  return createSyntheticShape(catalog, {
    capability,
    label: `call:${capability.id}`,
    title: `${capability.surface.title ?? capability.id} call`,
    node: {
      type: "object",
      fields: {
        input: {
          shapeId: executable.inputShapeId,
        },
      },
      required: ["input"],
      additionalProperties: false,
    },
    diagnostic: {
      level: "info",
      code: "projection_call_shape_synthesized",
      message: `Wrapped non-object MCP input shape for ${capability.id}`,
    },
  });
};

const projectCapability = (
  catalog: CatalogV1,
  capability: Capability,
): ToolDescriptor => {
  const executable = chooseExecutable(catalog, capability);
  const responseSet = catalog.responseSets[executable.responseSetId];

  if (!responseSet) {
    throw new Error(`Missing response set ${executable.responseSetId} for ${capability.id}`);
  }

  let callShapeId: ShapeSymbolId;
  let resultShapeId: ShapeSymbolId | undefined;

  switch (executable.protocol) {
    case "http":
      callShapeId = projectHttpCallShape(catalog, capability, executable);
      resultShapeId = projectExecutionResultShape(catalog, capability, executable, responseSet);
      break;
    case "graphql":
      callShapeId = projectGraphqlCallShape(catalog, capability, executable);
      resultShapeId = projectExecutionResultShape(catalog, capability, executable, responseSet);
      break;
    case "mcp":
      callShapeId = projectMcpCallShape(catalog, capability, executable);
      resultShapeId = projectExecutionResultShape(catalog, capability, executable, responseSet);
      break;
  }

  const diagnosticIds = unique([
    ...(capability.diagnosticIds ?? []),
    ...(executable.diagnosticIds ?? []),
    ...(responseSet.diagnosticIds ?? []),
    ...(callShapeId ? catalog.symbols[callShapeId]?.diagnosticIds ?? [] : []),
    ...(resultShapeId ? catalog.symbols[resultShapeId]?.diagnosticIds ?? [] : []),
  ]);
  const diagnostics = diagnosticIds
    .map((diagnosticId) => catalog.diagnostics[diagnosticId])
    .filter((diagnostic): diagnostic is ImportDiagnostic => diagnostic !== undefined);

  return {
    toolPath: [...capability.surface.toolPath],
    capabilityId: capability.id,
    ...(capability.surface.title ? { title: capability.surface.title } : {}),
    ...(capability.surface.summary ? { summary: capability.surface.summary } : {}),
    effect: capability.semantics.effect,
    interaction: {
      mayRequireApproval: capability.interaction.approval.mayRequire,
      mayElicit: capability.interaction.elicitation.mayRequest,
    },
    callShapeId,
    ...(resultShapeId ? { resultShapeId } : {}),
    responseSetId: executable.responseSetId,
    diagnosticCounts: {
      warning: diagnostics.filter((diagnostic) => diagnostic.level === "warning").length,
      error: diagnostics.filter((diagnostic) => diagnostic.level === "error").length,
    },
  };
};

const summaryView = (
  catalog: CatalogV1,
  capability: Capability,
  descriptor: ToolDescriptor,
): CapabilitySummaryView => ({
  capabilityId: capability.id,
  toolPath: [...capability.surface.toolPath],
  ...(capability.surface.summary ? { summary: capability.surface.summary } : {}),
  executableIds: [...capability.executableIds],
  auth: capability.auth,
  interaction: capability.interaction,
  callShapeId: descriptor.callShapeId,
  ...(descriptor.resultShapeId ? { resultShapeId: descriptor.resultShapeId } : {}),
  responseSetId: descriptor.responseSetId,
  ...(capability.diagnosticIds ? { diagnosticIds: [...capability.diagnosticIds] } : {}),
});

const searchDoc = (
  catalog: CatalogV1,
  capability: Capability,
): ToolSearchDoc => ({
  capabilityId: capability.id,
  toolPath: [...capability.surface.toolPath],
  ...(capability.surface.title ? { title: capability.surface.title } : {}),
  ...(capability.surface.summary ? { summary: capability.surface.summary } : {}),
  ...(capability.surface.tags ? { tags: [...capability.surface.tags] } : {}),
  protocolHints: unique(
    capability.executableIds
      .map((executableId: ExecutableId) => catalog.executables[executableId]?.protocol)
      .filter((protocol): protocol is Executable["protocol"] => protocol !== undefined),
  ),
  authHints: authHintStrings(catalog, capability.auth),
  effect: capability.semantics.effect,
});

const symbolTitle = (symbol: IrSymbol): string | undefined => {
  switch (symbol.kind) {
    case "shape":
      return symbol.title ?? symbol.docs?.summary;
    case "parameter":
    case "header":
      return symbol.name;
    case "example":
      return symbol.name ?? symbol.docs?.summary;
    case "requestBody":
    case "response":
    case "securityScheme":
      return symbol.docs?.summary;
  }
};

const symbolSummary = (symbol: IrSymbol): string | undefined =>
  symbol.docs?.summary ?? docsSummary(symbol.docs);

const symbolEdges = (symbol: IrSymbol): Array<{ label: string; targetId: SymbolId }> => {
  switch (symbol.kind) {
    case "shape": {
      const edges: Array<{ label: string; targetId: SymbolId }> = [];
      switch (symbol.node.type) {
        case "object":
          for (const [name, field] of Object.entries(symbol.node.fields)) {
            edges.push({ label: `field:${name}`, targetId: field.shapeId });
          }
          if (typeof symbol.node.additionalProperties !== "boolean" && symbol.node.additionalProperties) {
            edges.push({
              label: "additionalProperties",
              targetId: symbol.node.additionalProperties,
            });
          }
          for (const [pattern, targetId] of Object.entries(symbol.node.patternProperties ?? {})) {
            edges.push({ label: `pattern:${pattern}`, targetId });
          }
          break;
        case "array":
          edges.push({ label: "item", targetId: symbol.node.itemShapeId });
          break;
        case "tuple":
          symbol.node.itemShapeIds.forEach((targetId, index) => {
            edges.push({ label: `item:${String(index)}`, targetId });
          });
          if (typeof symbol.node.additionalItems !== "boolean" && symbol.node.additionalItems) {
            edges.push({ label: "additionalItems", targetId: symbol.node.additionalItems });
          }
          break;
        case "map":
          edges.push({ label: "value", targetId: symbol.node.valueShapeId });
          break;
        case "allOf":
        case "anyOf":
        case "oneOf":
          symbol.node.items.forEach((targetId, index) => {
            edges.push({ label: `${symbol.node.type}:${String(index)}`, targetId });
          });
          if (symbol.node.type === "oneOf") {
            for (const [key, targetId] of Object.entries(symbol.node.discriminator?.mapping ?? {})) {
              edges.push({ label: `discriminator:${key}`, targetId });
            }
          }
          break;
        case "nullable":
          edges.push({ label: "item", targetId: symbol.node.itemShapeId });
          break;
        case "ref":
          edges.push({ label: "target", targetId: symbol.node.target });
          break;
        case "not":
          edges.push({ label: "not", targetId: symbol.node.itemShapeId });
          break;
        case "conditional":
          edges.push({ label: "if", targetId: symbol.node.ifShapeId });
          if (symbol.node.thenShapeId) {
            edges.push({ label: "then", targetId: symbol.node.thenShapeId });
          }
          if (symbol.node.elseShapeId) {
            edges.push({ label: "else", targetId: symbol.node.elseShapeId });
          }
          break;
        case "graphqlInterface":
          for (const [name, field] of Object.entries(symbol.node.fields)) {
            edges.push({ label: `field:${name}`, targetId: field.shapeId });
          }
          symbol.node.possibleTypeIds.forEach((targetId) => {
            edges.push({ label: "possibleType", targetId });
          });
          break;
        case "graphqlUnion":
          symbol.node.memberTypeIds.forEach((targetId) => {
            edges.push({ label: "member", targetId });
          });
          break;
        default:
          break;
      }
      return edges;
    }
    case "parameter":
    case "header":
      return unique([
        ...(symbol.schemaShapeId ? [{ label: "schema", targetId: symbol.schemaShapeId as SymbolId }] : []),
        ...((symbol.content ?? []).flatMap((content, index) => [
          ...(content.shapeId ? [{ label: `content:${String(index)}`, targetId: content.shapeId as SymbolId }] : []),
          ...((content.exampleIds ?? []).map((targetId) => ({
            label: `example:${String(index)}`,
            targetId: targetId as SymbolId,
          }))),
        ])),
        ...((symbol.exampleIds ?? []).map((targetId) => ({
          label: "example",
          targetId: targetId as SymbolId,
        }))),
      ]);
    case "requestBody":
      return (symbol.contents ?? []).flatMap((content, index) => [
        ...(content.shapeId ? [{ label: `content:${String(index)}`, targetId: content.shapeId as SymbolId }] : []),
        ...((content.exampleIds ?? []).map((targetId) => ({
          label: `example:${String(index)}`,
          targetId: targetId as SymbolId,
        }))),
      ]);
    case "response":
      return [
        ...((symbol.headerIds ?? []).map((targetId) => ({
          label: "header",
          targetId: targetId as SymbolId,
        }))),
        ...((symbol.contents ?? []).flatMap((content, index) => [
          ...(content.shapeId ? [{ label: `content:${String(index)}`, targetId: content.shapeId as SymbolId }] : []),
          ...((content.exampleIds ?? []).map((targetId) => ({
            label: `example:${String(index)}`,
            targetId: targetId as SymbolId,
          }))),
        ])),
      ];
    case "example":
    case "securityScheme":
      return [];
  }
};

export const decodeCatalogV1 = (input: unknown): CatalogV1 => {
  try {
    return decodeCatalogSync(input);
  } catch (cause) {
    throw new Error(ParseResult.TreeFormatter.formatErrorSync(cause as never));
  }
};

export const decodeCatalogFragmentV1 = (input: unknown): CatalogFragmentV1 => {
  try {
    return decodeCatalogFragmentSync(input);
  } catch (cause) {
    throw new Error(ParseResult.TreeFormatter.formatErrorSync(cause as never));
  }
};

export const decodeCatalogSnapshotV1 = (input: unknown) => {
  try {
    const snapshot = decodeCatalogSnapshotSync(input);
    assertCatalogInvariants(snapshot.catalog);
    return snapshot;
  } catch (cause) {
    if (cause instanceof Error) {
      throw cause;
    }
    throw new Error(ParseResult.TreeFormatter.formatErrorSync(cause as never));
  }
};

export const createEmptyCatalogV1 = (): CatalogV1 => emptyCatalog();

export const createCatalogSnapshotV1 = (input: {
  import: ImportMetadata;
  catalog: CatalogV1;
}) => {
  const catalog = assertCatalogInvariants(decodeCatalogV1(input.catalog));

  return {
    version: "ir.v1.snapshot" as const,
    import: input.import,
    catalog,
  };
};

export const mergeCatalogFragments = (fragments: readonly CatalogFragmentV1[]): CatalogV1 => {
  const catalog = emptyCatalog();
  const seenByCollection = new Map<string, string>();

  const mergeRecord = <T extends { id: string }>(
    collectionName: keyof CatalogV1,
    entries: Record<string, T> | undefined,
  ) => {
    if (!entries) {
      return;
    }

    const target = catalog[collectionName] as Record<string, T>;
    for (const [id, entry] of Object.entries(entries)) {
      const existing = target[id];
      if (!existing) {
        target[id] = entry;
        seenByCollection.set(`${String(collectionName)}:${id}`, stableStringify(entry));
        continue;
      }

      const existingHash = seenByCollection.get(`${String(collectionName)}:${id}`) ?? stableStringify(existing);
      const nextHash = stableStringify(entry);
      if (existingHash === nextHash) {
        continue;
      }

      if (collectionName !== "diagnostics") {
        createDiagnostic(catalog, {
          idSeed: {
            collectionName,
            id,
            existingHash,
            nextHash,
          },
          level: "error",
          code: "merge_conflict_preserved_first",
          message: `Conflicting ${String(collectionName)} entry for ${id}; preserved first value`,
          provenance: "provenance" in existing
            ? (existing as { provenance: ImportDiagnostic["provenance"] }).provenance
            : [],
        });
      }
    }
  };

  for (const fragment of fragments) {
    mergeRecord("documents", fragment.documents);
    mergeRecord("resources", fragment.resources);
    mergeRecord("scopes", fragment.scopes);
    mergeRecord("symbols", fragment.symbols);
    mergeRecord("capabilities", fragment.capabilities);
    mergeRecord("executables", fragment.executables);
    mergeRecord("responseSets", fragment.responseSets);
    mergeRecord("diagnostics", fragment.diagnostics);
  }

  return assertCatalogInvariants(decodeCatalogV1(catalog));
};

export const validateCatalogInvariants = (
  catalog: CatalogV1,
): CatalogInvariantViolation[] => {
  const violations: CatalogInvariantViolation[] = [];

  const checkProvenanceDocuments = (input: {
    entityId: string;
    provenance: readonly { documentId: DocumentId }[];
  }) => {
    for (const provenance of input.provenance) {
      if (!catalog.documents[provenance.documentId]) {
        violations.push({
          code: "missing_provenance_document",
          entityId: input.entityId,
          message: `Entity ${input.entityId} references missing provenance document ${provenance.documentId}`,
        });
      }
    }
  };

  for (const symbol of Object.values(catalog.symbols)) {
    if (symbol.provenance.length === 0) {
      violations.push({
        code: "missing_symbol_provenance",
        entityId: symbol.id,
        message: `Symbol ${symbol.id} is missing provenance`,
      });
    }

    if (symbol.kind === "shape") {
      if (!symbol.resourceId && !symbol.synthetic) {
        violations.push({
          code: "missing_resource_context",
          entityId: symbol.id,
          message: `Shape ${symbol.id} must belong to a resource or be synthetic`,
        });
      }

      if (symbol.node.type === "ref" && !catalog.symbols[symbol.node.target]) {
        violations.push({
          code: "missing_reference_target",
          entityId: symbol.id,
          message: `Shape ${symbol.id} references missing shape ${symbol.node.target}`,
        });
      }

      if (symbol.node.type === "unknown" && symbol.node.reason?.includes("unresolved")) {
        const hasDiagnostic = (symbol.diagnosticIds ?? [])
          .map((diagnosticId) => catalog.diagnostics[diagnosticId])
          .some((diagnostic) => diagnostic?.code === "unresolved_ref");

        if (!hasDiagnostic) {
          violations.push({
            code: "missing_unresolved_ref_diagnostic",
            entityId: symbol.id,
            message: `Shape ${symbol.id} is unresolved but has no unresolved_ref diagnostic`,
          });
        }
      }

      if (symbol.synthetic && symbol.resourceId && !catalog.resources[symbol.resourceId]) {
        violations.push({
          code: "missing_resource_context",
          entityId: symbol.id,
          message: `Synthetic shape ${symbol.id} references missing resource ${symbol.resourceId}`,
        });
      }
    }

    checkProvenanceDocuments({
      entityId: symbol.id,
      provenance: symbol.provenance,
    });
  }

  for (const collection of [
    ...Object.values(catalog.resources),
    ...Object.values(catalog.scopes),
    ...Object.values(catalog.capabilities),
    ...Object.values(catalog.executables),
    ...Object.values(catalog.responseSets),
  ]) {
    if ("provenance" in collection && collection.provenance.length === 0) {
      violations.push({
        code: "missing_entity_provenance",
        entityId: "id" in collection ? collection.id : undefined,
        message: `Entity ${"id" in collection ? collection.id : "unknown"} is missing provenance`,
      });
    }

    if ("id" in collection) {
      checkProvenanceDocuments({
        entityId: collection.id,
        provenance: collection.provenance,
      });
    }
  }

  for (const resource of Object.values(catalog.resources)) {
    if (!catalog.documents[resource.documentId]) {
      violations.push({
        code: "missing_document",
        entityId: resource.id,
        message: `Resource ${resource.id} references missing document ${resource.documentId}`,
      });
    }
  }

  for (const capability of Object.values(catalog.capabilities)) {
    if (!catalog.scopes[capability.serviceScopeId]) {
      violations.push({
        code: "missing_service_scope",
        entityId: capability.id,
        message: `Capability ${capability.id} references missing scope ${capability.serviceScopeId}`,
      });
    }

    if (
      capability.preferredExecutableId
      && !capability.executableIds.includes(capability.preferredExecutableId)
    ) {
      violations.push({
        code: "invalid_preferred_executable",
        entityId: capability.id,
        message: `Capability ${capability.id} preferred executable is not in executableIds`,
      });
    }

    for (const executableId of capability.executableIds) {
      if (!catalog.executables[executableId]) {
        violations.push({
          code: "missing_executable",
          entityId: capability.id,
          message: `Capability ${capability.id} references missing executable ${executableId}`,
        });
      }
    }
  }

  for (const executable of Object.values(catalog.executables)) {
    if (!catalog.capabilities[executable.capabilityId]) {
      violations.push({
        code: "missing_executable",
        entityId: executable.id,
        message: `Executable ${executable.id} references missing capability ${executable.capabilityId}`,
      });
    }

    if (!catalog.scopes[executable.scopeId]) {
      violations.push({
        code: "missing_scope",
        entityId: executable.id,
        message: `Executable ${executable.id} references missing scope ${executable.scopeId}`,
      });
    }

    if (!catalog.responseSets[executable.responseSetId]) {
      violations.push({
        code: "missing_response_set",
        entityId: executable.id,
        message: `Executable ${executable.id} references missing response set ${executable.responseSetId}`,
      });
    }
  }

  return violations;
};

const assertCatalogInvariants = (catalog: CatalogV1): CatalogV1 => {
  const violations = validateCatalogInvariants(catalog);
  if (violations.length === 0) {
    return catalog;
  }

  const preview = violations
    .slice(0, 5)
    .map((violation) => `${violation.code}: ${violation.message}`)
    .join("\n");

  throw new Error(
    [
      `Invalid IR catalog (${violations.length} invariant violation${violations.length === 1 ? "" : "s"}).`,
      preview,
      ...(violations.length > 5 ? [`...and ${String(violations.length - 5)} more`] : []),
    ].join("\n"),
  );
};

export const projectCatalogForAgentSdk = (input: {
  catalog: CatalogV1;
}): ProjectedCatalog => {
  const workingCatalog = cloneCatalog(input.catalog);
  const toolDescriptors = {} as Record<CapabilityId, ToolDescriptor>;
  const searchDocs = {} as Record<CapabilityId, ToolSearchDoc>;
  const capabilityViews = {} as Record<CapabilityId, CapabilitySummaryView>;

  const capabilities = Object.values(workingCatalog.capabilities)
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const capability of capabilities) {
    const descriptor = projectCapability(workingCatalog, capability);
    toolDescriptors[capability.id] = descriptor;
    searchDocs[capability.id] = searchDoc(workingCatalog, capability);
    capabilityViews[capability.id] = summaryView(workingCatalog, capability, descriptor);
  }

  return {
    catalog: workingCatalog,
    toolDescriptors,
    searchDocs,
    capabilityViews,
  };
};

export const projectSymbolShallowView = (
  catalog: CatalogV1,
  symbolId: SymbolId,
): SymbolShallowView => {
  const symbol = catalog.symbols[symbolId];
  if (!symbol) {
    throw new Error(`Unknown symbol ${symbolId}`);
  }

  return {
    symbolId,
    kind: symbol.kind,
    ...(symbolTitle(symbol) ? { title: symbolTitle(symbol) } : {}),
    ...(symbolSummary(symbol) ? { summary: symbolSummary(symbol) } : {}),
    edges: symbolEdges(symbol),
  };
};

export const projectSymbolExpandedView = (
  catalog: CatalogV1,
  symbolId: SymbolId,
): SymbolExpandedView => {
  const symbol = catalog.symbols[symbolId];
  if (!symbol) {
    throw new Error(`Unknown symbol ${symbolId}`);
  }

  return {
    symbolId,
    symbol,
    ...(symbol.diagnosticIds
      ? {
          diagnostics: symbol.diagnosticIds
            .map((diagnosticId) => catalog.diagnostics[diagnosticId])
            .filter((diagnostic): diagnostic is ImportDiagnostic => diagnostic !== undefined),
        }
      : {}),
  };
};

export const buildInvocationPlan = (input: {
  catalog: CatalogV1;
  capabilityId: CapabilityId;
  executableId?: ExecutableId;
  connectionBindingId: string;
  resolvedEndpoint?: string;
  resolvedAuth?: unknown;
  resolvedInteraction?: Partial<InvocationPlan["resolvedInteraction"]>;
  requestPlan: unknown;
}): InvocationPlan => {
  const capability = input.catalog.capabilities[input.capabilityId];
  if (!capability) {
    throw new Error(`Unknown capability ${input.capabilityId}`);
  }

  const executable = input.executableId
    ? input.catalog.executables[input.executableId]
    : chooseExecutable(input.catalog, capability);
  if (!executable) {
    throw new Error(`Unknown executable for capability ${input.capabilityId}`);
  }

  const scopes = scopeChain(input.catalog, executable.scopeId).map((scope) => scope.id);

  return {
    capabilityId: capability.id,
    executableId: executable.id,
    connectionBindingId: input.connectionBindingId,
    resolvedScopeChain: scopes,
    ...(input.resolvedEndpoint ? { resolvedEndpoint: input.resolvedEndpoint } : {}),
    ...(input.resolvedAuth !== undefined ? { resolvedAuth: input.resolvedAuth } : {}),
    resolvedInteraction: {
      requiresApproval: input.resolvedInteraction?.requiresApproval
        ?? capability.interaction.approval.mayRequire,
      mayPauseForElicitation: input.resolvedInteraction?.mayPauseForElicitation
        ?? capability.interaction.elicitation.mayRequest,
      resumable: input.resolvedInteraction?.resumable
        ?? capability.interaction.resume.supported,
    },
    requestPlan: input.requestPlan,
    provenance: capability.provenance,
  };
};
