import { Schema } from "effect";

import {
  CapabilityIdSchema,
  DiagnosticIdSchema,
  DocumentIdSchema,
  ExecutableIdSchema,
  ExampleSymbolIdSchema,
  HeaderSymbolIdSchema,
  ParameterSymbolIdSchema,
  RequestBodySymbolIdSchema,
  ResourceIdSchema,
  ResponseSetIdSchema,
  ResponseSymbolIdSchema,
  ScopeIdSchema,
  SecuritySchemeSymbolIdSchema,
  type SecuritySchemeSymbolId,
  ShapeSymbolIdSchema,
  SymbolIdSchema,
} from "./ids";

export const SourceKindSchema = Schema.Literal(
  "openapi",
  "graphql-schema",
  "google-discovery",
  "mcp",
  "custom",
);

export const ScopeKindSchema = Schema.Literal(
  "service",
  "document",
  "resource",
  "pathItem",
  "operation",
  "folder",
);

export const EffectKindSchema = Schema.Literal(
  "read",
  "write",
  "delete",
  "action",
  "subscribe",
);

export const ParameterLocationSchema = Schema.Literal(
  "path",
  "query",
  "header",
  "cookie",
);

export const ResponseTraitSchema = Schema.Literal(
  "success",
  "redirect",
  "stream",
  "download",
  "upload",
  "longRunning",
);

export const SecuritySchemeTypeSchema = Schema.Literal(
  "oauth2",
  "http",
  "apiKey",
  "basic",
  "bearer",
  "custom",
);

export const StatusRangeSchema = Schema.Literal(
  "1XX",
  "2XX",
  "3XX",
  "4XX",
  "5XX",
);

export const PaginationHintKindSchema = Schema.Literal(
  "cursor",
  "offset",
  "token",
  "unknown",
);

export const DiagnosticLevelSchema = Schema.Literal(
  "info",
  "warning",
  "error",
);

export const DiagnosticCodeSchema = Schema.Literal(
  "external_ref_bundled",
  "relative_ref_rebased",
  "schema_hoisted",
  "selection_shape_synthesized",
  "opaque_hook_imported",
  "discriminator_lost",
  "multi_response_union_synthesized",
  "unsupported_link_preserved_native",
  "unsupported_callback_preserved_native",
  "unresolved_ref",
  "merge_conflict_preserved_first",
  "projection_call_shape_synthesized",
  "projection_result_shape_synthesized",
  "projection_collision_grouped_fields",
  "synthetic_resource_context_created",
  "selection_shape_missing",
);

export const NativeEncodingSchema = Schema.Literal(
  "json",
  "yaml",
  "graphql",
  "text",
  "unknown",
);

export const ProvenanceRelationSchema = Schema.Literal(
  "declared",
  "hoisted",
  "derived",
  "merged",
  "projected",
);

export const DocumentationBlockSchema = Schema.Struct({
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  externalDocsUrl: Schema.optional(Schema.String),
});

export const ProvenanceRefSchema = Schema.Struct({
  relation: ProvenanceRelationSchema,
  documentId: DocumentIdSchema,
  resourceId: Schema.optional(ResourceIdSchema),
  pointer: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
  column: Schema.optional(Schema.Number),
});

export const NativeBlobSchema = Schema.Struct({
  sourceKind: SourceKindSchema,
  kind: Schema.String,
  pointer: Schema.optional(Schema.String),
  encoding: Schema.optional(NativeEncodingSchema),
  summary: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
});

export const EntityBaseSchema = Schema.Struct({
  synthetic: Schema.Boolean,
  provenance: Schema.Array(ProvenanceRefSchema),
  diagnosticIds: Schema.optional(Schema.Array(DiagnosticIdSchema)),
  native: Schema.optional(Schema.Array(NativeBlobSchema)),
});

export const ImportMetadataSchema = Schema.Struct({
  sourceKind: SourceKindSchema,
  pluginKey: Schema.String,
  importerVersion: Schema.String,
  importedAt: Schema.String,
  sourceConfigHash: Schema.String,
});

export const SourceDocumentSchema = Schema.Struct({
  id: DocumentIdSchema,
  kind: SourceKindSchema,
  title: Schema.optional(Schema.String),
  versionHint: Schema.optional(Schema.String),
  fetchedAt: Schema.String,
  rawRef: Schema.String,
  entryUri: Schema.optional(Schema.String),
  native: Schema.optional(Schema.Array(NativeBlobSchema)),
});

export const FieldSpecSchema = Schema.Struct({
  shapeId: ShapeSymbolIdSchema,
  docs: Schema.optional(DocumentationBlockSchema),
  deprecated: Schema.optional(Schema.Boolean),
  exampleIds: Schema.optional(Schema.Array(ExampleSymbolIdSchema)),
});

export const DiscriminatorSpecSchema = Schema.Struct({
  propertyName: Schema.String,
  mapping: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: ShapeSymbolIdSchema,
    }),
  ),
});

export const ScalarShapeSchema = Schema.Struct({
  type: Schema.Literal("scalar"),
  scalar: Schema.Literal("string", "number", "integer", "boolean", "null", "bytes"),
  format: Schema.optional(Schema.String),
  constraints: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
  ),
});

export const UnknownShapeSchema = Schema.Struct({
  type: Schema.Literal("unknown"),
  reason: Schema.optional(Schema.String),
});

export const ConstShapeSchema = Schema.Struct({
  type: Schema.Literal("const"),
  value: Schema.Unknown,
});

export const EnumShapeSchema = Schema.Struct({
  type: Schema.Literal("enum"),
  values: Schema.Array(Schema.Unknown),
});

export const ObjectShapeSchema = Schema.Struct({
  type: Schema.Literal("object"),
  fields: Schema.Record({
    key: Schema.String,
    value: FieldSpecSchema,
  }),
  required: Schema.optional(Schema.Array(Schema.String)),
  additionalProperties: Schema.optional(
    Schema.Union(Schema.Boolean, ShapeSymbolIdSchema),
  ),
  patternProperties: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: ShapeSymbolIdSchema,
    }),
  ),
});

export const ArrayShapeSchema = Schema.Struct({
  type: Schema.Literal("array"),
  itemShapeId: ShapeSymbolIdSchema,
  minItems: Schema.optional(Schema.Number),
  maxItems: Schema.optional(Schema.Number),
});

export const TupleShapeSchema = Schema.Struct({
  type: Schema.Literal("tuple"),
  itemShapeIds: Schema.Array(ShapeSymbolIdSchema),
  additionalItems: Schema.optional(
    Schema.Union(Schema.Boolean, ShapeSymbolIdSchema),
  ),
});

export const MapShapeSchema = Schema.Struct({
  type: Schema.Literal("map"),
  valueShapeId: ShapeSymbolIdSchema,
});

export const AllOfShapeSchema = Schema.Struct({
  type: Schema.Literal("allOf"),
  items: Schema.Array(ShapeSymbolIdSchema),
});

export const AnyOfShapeSchema = Schema.Struct({
  type: Schema.Literal("anyOf"),
  items: Schema.Array(ShapeSymbolIdSchema),
});

export const OneOfShapeSchema = Schema.Struct({
  type: Schema.Literal("oneOf"),
  items: Schema.Array(ShapeSymbolIdSchema),
  discriminator: Schema.optional(DiscriminatorSpecSchema),
});

export const NullableShapeSchema = Schema.Struct({
  type: Schema.Literal("nullable"),
  itemShapeId: ShapeSymbolIdSchema,
});

export const RefShapeSchema = Schema.Struct({
  type: Schema.Literal("ref"),
  target: ShapeSymbolIdSchema,
});

export const NotShapeSchema = Schema.Struct({
  type: Schema.Literal("not"),
  itemShapeId: ShapeSymbolIdSchema,
});

export const ConditionalShapeSchema = Schema.Struct({
  type: Schema.Literal("conditional"),
  ifShapeId: ShapeSymbolIdSchema,
  thenShapeId: Schema.optional(ShapeSymbolIdSchema),
  elseShapeId: Schema.optional(ShapeSymbolIdSchema),
});

export const GraphQLInterfaceShapeSchema = Schema.Struct({
  type: Schema.Literal("graphqlInterface"),
  fields: Schema.Record({
    key: Schema.String,
    value: FieldSpecSchema,
  }),
  possibleTypeIds: Schema.Array(ShapeSymbolIdSchema),
});

export const GraphQLUnionShapeSchema = Schema.Struct({
  type: Schema.Literal("graphqlUnion"),
  memberTypeIds: Schema.Array(ShapeSymbolIdSchema),
});

export const ShapeNodeSchema = Schema.Union(
  UnknownShapeSchema,
  ScalarShapeSchema,
  ConstShapeSchema,
  EnumShapeSchema,
  ObjectShapeSchema,
  ArrayShapeSchema,
  TupleShapeSchema,
  MapShapeSchema,
  AllOfShapeSchema,
  AnyOfShapeSchema,
  OneOfShapeSchema,
  NullableShapeSchema,
  RefShapeSchema,
  NotShapeSchema,
  ConditionalShapeSchema,
  GraphQLInterfaceShapeSchema,
  GraphQLUnionShapeSchema,
);

export const AnchorTargetSchema = Schema.Struct({
  shapeId: ShapeSymbolIdSchema,
  pointer: Schema.optional(Schema.String),
});

export const SchemaResourceSchema = Schema.extend(
  Schema.Struct({
    id: ResourceIdSchema,
    documentId: DocumentIdSchema,
    canonicalUri: Schema.String,
    baseUri: Schema.String,
    dialectUri: Schema.optional(Schema.String),
    rootShapeId: Schema.optional(ShapeSymbolIdSchema),
    anchors: Schema.Record({
      key: Schema.String,
      value: AnchorTargetSchema,
    }),
    dynamicAnchors: Schema.Record({
      key: Schema.String,
      value: AnchorTargetSchema,
    }),
  }),
  EntityBaseSchema,
);

export const RequestPlacementHintSchema = Schema.Union(
  Schema.Struct({
    location: Schema.Literal("header", "query", "cookie"),
    name: Schema.String,
  }),
  Schema.Struct({
    location: Schema.Literal("body"),
    path: Schema.String,
  }),
);

export const OAuthFlowSchema = Schema.Struct({
  authorizationUrl: Schema.optional(Schema.String),
  tokenUrl: Schema.optional(Schema.String),
  refreshUrl: Schema.optional(Schema.String),
  scopes: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

export const SecurityPlacementSchema = Schema.Struct({
  in: Schema.optional(Schema.Literal("header", "query", "cookie")),
  name: Schema.optional(Schema.String),
});

export const SecuritySchemeSymbolSchema = Schema.extend(
  Schema.Struct({
    id: SecuritySchemeSymbolIdSchema,
    kind: Schema.Literal("securityScheme"),
    schemeType: SecuritySchemeTypeSchema,
    docs: Schema.optional(DocumentationBlockSchema),
    placement: Schema.optional(SecurityPlacementSchema),
    http: Schema.optional(
      Schema.Struct({
        scheme: Schema.String,
        bearerFormat: Schema.optional(Schema.String),
      }),
    ),
    apiKey: Schema.optional(
      Schema.Struct({
        in: Schema.Literal("header", "query", "cookie"),
        name: Schema.String,
      }),
    ),
    oauth: Schema.optional(
      Schema.Struct({
        flows: Schema.optional(
          Schema.Record({
            key: Schema.String,
            value: OAuthFlowSchema,
          }),
        ),
        scopes: Schema.optional(
          Schema.Record({
            key: Schema.String,
            value: Schema.String,
          }),
        ),
      }),
    ),
    custom: Schema.optional(
      Schema.Struct({
        placementHints: Schema.optional(Schema.Array(RequestPlacementHintSchema)),
      }),
    ),
  }),
  EntityBaseSchema,
);

export const EncodingSpecSchema = Schema.Struct({
  contentType: Schema.optional(Schema.String),
  style: Schema.optional(Schema.String),
  explode: Schema.optional(Schema.Boolean),
  allowReserved: Schema.optional(Schema.Boolean),
  headers: Schema.optional(Schema.Array(HeaderSymbolIdSchema)),
});

export const ContentSpecSchema = Schema.Struct({
  mediaType: Schema.String,
  shapeId: Schema.optional(ShapeSymbolIdSchema),
  exampleIds: Schema.optional(Schema.Array(ExampleSymbolIdSchema)),
  encoding: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: EncodingSpecSchema,
    }),
  ),
});

export const ShapeSymbolSchema = Schema.extend(
  Schema.Struct({
    id: ShapeSymbolIdSchema,
    kind: Schema.Literal("shape"),
    resourceId: Schema.optional(ResourceIdSchema),
    title: Schema.optional(Schema.String),
    docs: Schema.optional(DocumentationBlockSchema),
    deprecated: Schema.optional(Schema.Boolean),
    node: ShapeNodeSchema,
  }),
  EntityBaseSchema,
);

export const ParameterSymbolSchema = Schema.extend(
  Schema.Struct({
    id: ParameterSymbolIdSchema,
    kind: Schema.Literal("parameter"),
    name: Schema.String,
    location: ParameterLocationSchema,
    required: Schema.optional(Schema.Boolean),
    docs: Schema.optional(DocumentationBlockSchema),
    deprecated: Schema.optional(Schema.Boolean),
    exampleIds: Schema.optional(Schema.Array(ExampleSymbolIdSchema)),
    schemaShapeId: Schema.optional(ShapeSymbolIdSchema),
    content: Schema.optional(Schema.Array(ContentSpecSchema)),
    style: Schema.optional(Schema.String),
    explode: Schema.optional(Schema.Boolean),
    allowReserved: Schema.optional(Schema.Boolean),
  }),
  EntityBaseSchema,
);

export const HeaderSymbolSchema = Schema.extend(
  Schema.Struct({
    id: HeaderSymbolIdSchema,
    kind: Schema.Literal("header"),
    name: Schema.String,
    docs: Schema.optional(DocumentationBlockSchema),
    deprecated: Schema.optional(Schema.Boolean),
    exampleIds: Schema.optional(Schema.Array(ExampleSymbolIdSchema)),
    schemaShapeId: Schema.optional(ShapeSymbolIdSchema),
    content: Schema.optional(Schema.Array(ContentSpecSchema)),
    style: Schema.optional(Schema.String),
    explode: Schema.optional(Schema.Boolean),
  }),
  EntityBaseSchema,
);

export const RequestBodySymbolSchema = Schema.extend(
  Schema.Struct({
    id: RequestBodySymbolIdSchema,
    kind: Schema.Literal("requestBody"),
    docs: Schema.optional(DocumentationBlockSchema),
    required: Schema.optional(Schema.Boolean),
    contents: Schema.Array(ContentSpecSchema),
  }),
  EntityBaseSchema,
);

export const ResponseSymbolSchema = Schema.extend(
  Schema.Struct({
    id: ResponseSymbolIdSchema,
    kind: Schema.Literal("response"),
    docs: Schema.optional(DocumentationBlockSchema),
    headerIds: Schema.optional(Schema.Array(HeaderSymbolIdSchema)),
    contents: Schema.optional(Schema.Array(ContentSpecSchema)),
  }),
  EntityBaseSchema,
);

export const ExampleSymbolSchema = Schema.extend(
  Schema.Struct({
    id: ExampleSymbolIdSchema,
    kind: Schema.Literal("example"),
    name: Schema.optional(Schema.String),
    docs: Schema.optional(DocumentationBlockSchema),
    exampleKind: Schema.Literal("value", "call"),
    value: Schema.optional(Schema.Unknown),
    externalValue: Schema.optional(Schema.String),
    call: Schema.optional(
      Schema.Struct({
        args: Schema.Record({
          key: Schema.String,
          value: Schema.Unknown,
        }),
        result: Schema.optional(Schema.Unknown),
      }),
    ),
  }),
  EntityBaseSchema,
);

export const SymbolSchema = Schema.Union(
  ShapeSymbolSchema,
  ParameterSymbolSchema,
  RequestBodySymbolSchema,
  ResponseSymbolSchema,
  HeaderSymbolSchema,
  ExampleSymbolSchema,
  SecuritySchemeSymbolSchema,
);

export type AuthRequirement =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "scheme";
      readonly schemeId: SecuritySchemeSymbolId;
      readonly scopes?: readonly string[];
    }
  | {
      readonly kind: "allOf";
      readonly items: readonly AuthRequirement[];
    }
  | {
      readonly kind: "anyOf";
      readonly items: readonly AuthRequirement[];
    };

export const AuthRequirementSchema = Schema.suspend(() =>
  Schema.Union(
    Schema.Struct({
      kind: Schema.Literal("none"),
    }),
    Schema.Struct({
      kind: Schema.Literal("scheme"),
      schemeId: SecuritySchemeSymbolIdSchema,
      scopes: Schema.optional(Schema.Array(Schema.String)),
    }),
    Schema.Struct({
      kind: Schema.Literal("allOf"),
      items: Schema.Array(AuthRequirementSchema),
    }),
    Schema.Struct({
      kind: Schema.Literal("anyOf"),
      items: Schema.Array(AuthRequirementSchema),
    }),
  )
) as Schema.Schema<AuthRequirement, AuthRequirement, never>;

export const ServerSpecSchema = Schema.Struct({
  url: Schema.String,
  description: Schema.optional(Schema.String),
  variables: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

export const ScopeDefaultsSchema = Schema.Struct({
  servers: Schema.optional(Schema.Array(ServerSpecSchema)),
  auth: Schema.optional(AuthRequirementSchema),
  parameterIds: Schema.optional(Schema.Array(ParameterSymbolIdSchema)),
  headerIds: Schema.optional(Schema.Array(HeaderSymbolIdSchema)),
  variables: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

export const ScopeSchema = Schema.extend(
  Schema.Struct({
    id: ScopeIdSchema,
    kind: ScopeKindSchema,
    parentId: Schema.optional(ScopeIdSchema),
    name: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    docs: Schema.optional(DocumentationBlockSchema),
    defaults: Schema.optional(ScopeDefaultsSchema),
  }),
  EntityBaseSchema,
);

export const InteractionSpecSchema = Schema.Struct({
  approval: Schema.Struct({
    mayRequire: Schema.Boolean,
    reasons: Schema.optional(
      Schema.Array(
        Schema.Literal("write", "delete", "sensitive", "externalSideEffect"),
      ),
    ),
  }),
  elicitation: Schema.Struct({
    mayRequest: Schema.Boolean,
    shapeId: Schema.optional(ShapeSymbolIdSchema),
  }),
  resume: Schema.Struct({
    supported: Schema.Boolean,
  }),
});

export const CapabilitySchema = Schema.extend(
  Schema.Struct({
    id: CapabilityIdSchema,
    serviceScopeId: ScopeIdSchema,
    surface: Schema.Struct({
      toolPath: Schema.Array(Schema.String),
      title: Schema.optional(Schema.String),
      summary: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      aliases: Schema.optional(Schema.Array(Schema.String)),
      tags: Schema.optional(Schema.Array(Schema.String)),
    }),
    semantics: Schema.Struct({
      effect: EffectKindSchema,
      safe: Schema.optional(Schema.Boolean),
      idempotent: Schema.optional(Schema.Boolean),
      destructive: Schema.optional(Schema.Boolean),
    }),
    docs: Schema.optional(DocumentationBlockSchema),
    auth: AuthRequirementSchema,
    interaction: InteractionSpecSchema,
    executableIds: Schema.Array(ExecutableIdSchema),
    preferredExecutableId: Schema.optional(ExecutableIdSchema),
    exampleIds: Schema.optional(Schema.Array(ExampleSymbolIdSchema)),
  }),
  EntityBaseSchema,
);

export const ExecutableDisplaySchema = Schema.Struct({
  protocol: Schema.optional(Schema.String),
  method: Schema.optional(Schema.NullOr(Schema.String)),
  pathTemplate: Schema.optional(Schema.NullOr(Schema.String)),
  operationId: Schema.optional(Schema.NullOr(Schema.String)),
  group: Schema.optional(Schema.NullOr(Schema.String)),
  leaf: Schema.optional(Schema.NullOr(Schema.String)),
  rawToolId: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ExecutableProjectionSchema = Schema.Struct({
  responseSetId: ResponseSetIdSchema,
  callShapeId: ShapeSymbolIdSchema,
  resultDataShapeId: Schema.optional(ShapeSymbolIdSchema),
  resultErrorShapeId: Schema.optional(ShapeSymbolIdSchema),
  resultHeadersShapeId: Schema.optional(ShapeSymbolIdSchema),
  resultStatusShapeId: Schema.optional(ShapeSymbolIdSchema),
});

export const ExecutableSchema = Schema.extend(
  Schema.Struct({
    id: ExecutableIdSchema,
    capabilityId: CapabilityIdSchema,
    scopeId: ScopeIdSchema,
    pluginKey: Schema.String,
    bindingVersion: Schema.Number,
    binding: Schema.Unknown,
    projection: ExecutableProjectionSchema,
    display: Schema.optional(ExecutableDisplaySchema),
  }),
  EntityBaseSchema,
);

export const PaginationHintSchema = Schema.Struct({
  kind: PaginationHintKindSchema,
  tokenParamName: Schema.optional(Schema.String),
  nextFieldPath: Schema.optional(Schema.String),
});

export const StatusMatchSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("exact"),
    status: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("range"),
    value: StatusRangeSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("default"),
  }),
);

export const ResponseVariantSchema = Schema.Struct({
  match: StatusMatchSchema,
  responseId: ResponseSymbolIdSchema,
  traits: Schema.optional(Schema.Array(ResponseTraitSchema)),
  pagination: Schema.optional(PaginationHintSchema),
});

export const ResponseSetSchema = Schema.extend(
  Schema.Struct({
    id: ResponseSetIdSchema,
    variants: Schema.Array(ResponseVariantSchema),
  }),
  EntityBaseSchema,
);

export const ImportDiagnosticSchema = Schema.Struct({
  id: DiagnosticIdSchema,
  level: DiagnosticLevelSchema,
  code: DiagnosticCodeSchema,
  message: Schema.String,
  relatedSymbolIds: Schema.optional(Schema.Array(SymbolIdSchema)),
  provenance: Schema.Array(ProvenanceRefSchema),
});

export const CatalogV1Schema = Schema.Struct({
  version: Schema.Literal("ir.v1"),
  documents: Schema.Record({
    key: DocumentIdSchema,
    value: SourceDocumentSchema,
  }),
  resources: Schema.Record({
    key: ResourceIdSchema,
    value: SchemaResourceSchema,
  }),
  scopes: Schema.Record({
    key: ScopeIdSchema,
    value: ScopeSchema,
  }),
  symbols: Schema.Record({
    key: Schema.String,
    value: SymbolSchema,
  }),
  capabilities: Schema.Record({
    key: CapabilityIdSchema,
    value: CapabilitySchema,
  }),
  executables: Schema.Record({
    key: ExecutableIdSchema,
    value: ExecutableSchema,
  }),
  responseSets: Schema.Record({
    key: ResponseSetIdSchema,
    value: ResponseSetSchema,
  }),
  diagnostics: Schema.Record({
    key: DiagnosticIdSchema,
    value: ImportDiagnosticSchema,
  }),
});

export const CatalogFragmentV1Schema = Schema.Struct({
  version: Schema.Literal("ir.v1.fragment"),
  documents: Schema.optional(
    Schema.Record({
      key: DocumentIdSchema,
      value: SourceDocumentSchema,
    }),
  ),
  resources: Schema.optional(
    Schema.Record({
      key: ResourceIdSchema,
      value: SchemaResourceSchema,
    }),
  ),
  scopes: Schema.optional(
    Schema.Record({
      key: ScopeIdSchema,
      value: ScopeSchema,
    }),
  ),
  symbols: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: SymbolSchema,
    }),
  ),
  capabilities: Schema.optional(
    Schema.Record({
      key: CapabilityIdSchema,
      value: CapabilitySchema,
    }),
  ),
  executables: Schema.optional(
    Schema.Record({
      key: ExecutableIdSchema,
      value: ExecutableSchema,
    }),
  ),
  responseSets: Schema.optional(
    Schema.Record({
      key: ResponseSetIdSchema,
      value: ResponseSetSchema,
    }),
  ),
  diagnostics: Schema.optional(
    Schema.Record({
      key: DiagnosticIdSchema,
      value: ImportDiagnosticSchema,
    }),
  ),
});

export const CatalogSnapshotV1Schema = Schema.Struct({
  version: Schema.Literal("ir.v1.snapshot"),
  import: ImportMetadataSchema,
  catalog: CatalogV1Schema,
});

export type SourceKind = typeof SourceKindSchema.Type;
export type ScopeKind = typeof ScopeKindSchema.Type;
export type EffectKind = typeof EffectKindSchema.Type;
export type ParameterLocation = typeof ParameterLocationSchema.Type;
export type ResponseTrait = typeof ResponseTraitSchema.Type;
export type SecuritySchemeType = typeof SecuritySchemeTypeSchema.Type;
export type PaginationHintKind = typeof PaginationHintKindSchema.Type;
export type DiagnosticCode = typeof DiagnosticCodeSchema.Type;
export type DiagnosticLevel = typeof DiagnosticLevelSchema.Type;

export type DocumentationBlock = typeof DocumentationBlockSchema.Type;
export type ProvenanceRef = typeof ProvenanceRefSchema.Type;
export type NativeBlob = typeof NativeBlobSchema.Type;
export type EntityBase = typeof EntityBaseSchema.Type;
export type ImportMetadata = typeof ImportMetadataSchema.Type;
export type SourceDocument = typeof SourceDocumentSchema.Type;
export type FieldSpec = typeof FieldSpecSchema.Type;
export type DiscriminatorSpec = typeof DiscriminatorSpecSchema.Type;
export type ScalarShape = typeof ScalarShapeSchema.Type;
export type UnknownShape = typeof UnknownShapeSchema.Type;
export type ConstShape = typeof ConstShapeSchema.Type;
export type EnumShape = typeof EnumShapeSchema.Type;
export type ObjectShape = typeof ObjectShapeSchema.Type;
export type ArrayShape = typeof ArrayShapeSchema.Type;
export type TupleShape = typeof TupleShapeSchema.Type;
export type MapShape = typeof MapShapeSchema.Type;
export type AllOfShape = typeof AllOfShapeSchema.Type;
export type AnyOfShape = typeof AnyOfShapeSchema.Type;
export type OneOfShape = typeof OneOfShapeSchema.Type;
export type NullableShape = typeof NullableShapeSchema.Type;
export type RefShape = typeof RefShapeSchema.Type;
export type NotShape = typeof NotShapeSchema.Type;
export type ConditionalShape = typeof ConditionalShapeSchema.Type;
export type GraphQLInterfaceShape = typeof GraphQLInterfaceShapeSchema.Type;
export type GraphQLUnionShape = typeof GraphQLUnionShapeSchema.Type;
export type ShapeNode = typeof ShapeNodeSchema.Type;
export type AnchorTarget = typeof AnchorTargetSchema.Type;
export type SchemaResource = typeof SchemaResourceSchema.Type;
export type RequestPlacementHint = typeof RequestPlacementHintSchema.Type;
export type OAuthFlow = typeof OAuthFlowSchema.Type;
export type SecurityPlacement = typeof SecurityPlacementSchema.Type;
export type SecuritySchemeSymbol = typeof SecuritySchemeSymbolSchema.Type;
export type EncodingSpec = typeof EncodingSpecSchema.Type;
export type ContentSpec = typeof ContentSpecSchema.Type;
export type ShapeSymbol = typeof ShapeSymbolSchema.Type;
export type ParameterSymbol = typeof ParameterSymbolSchema.Type;
export type HeaderSymbol = typeof HeaderSymbolSchema.Type;
export type RequestBodySymbol = typeof RequestBodySymbolSchema.Type;
export type ResponseSymbol = typeof ResponseSymbolSchema.Type;
export type ExampleSymbol = typeof ExampleSymbolSchema.Type;
export type Symbol =
  | ShapeSymbol
  | ParameterSymbol
  | RequestBodySymbol
  | ResponseSymbol
  | HeaderSymbol
  | ExampleSymbol
  | SecuritySchemeSymbol;
export type ServerSpec = typeof ServerSpecSchema.Type;
export type ScopeDefaults = typeof ScopeDefaultsSchema.Type;
export type Scope = typeof ScopeSchema.Type;
export type InteractionSpec = typeof InteractionSpecSchema.Type;
export type Capability = typeof CapabilitySchema.Type;
export type ExecutableDisplay = typeof ExecutableDisplaySchema.Type;
export type ExecutableProjection = typeof ExecutableProjectionSchema.Type;
export type Executable = typeof ExecutableSchema.Type;
export type PaginationHint = typeof PaginationHintSchema.Type;
export type StatusMatch = typeof StatusMatchSchema.Type;
export type ResponseVariant = typeof ResponseVariantSchema.Type;
export type ResponseSet = typeof ResponseSetSchema.Type;
export type ImportDiagnostic = typeof ImportDiagnosticSchema.Type;
export type CatalogV1 = typeof CatalogV1Schema.Type;
export type CatalogFragmentV1 = typeof CatalogFragmentV1Schema.Type;
export type CatalogSnapshotV1 = typeof CatalogSnapshotV1Schema.Type;
