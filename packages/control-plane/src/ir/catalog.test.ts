import { describe, expect, it } from "@effect/vitest";

import {
  buildInvocationPlan,
  createCatalogSnapshotV1,
  createEmptyCatalogV1,
  decodeCatalogSnapshotV1,
  mergeCatalogFragments,
  projectCatalogForAgentSdk,
  projectSymbolExpandedView,
  projectSymbolShallowView,
  validateCatalogInvariants,
} from "./catalog";
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
  ShapeSymbolIdSchema,
} from "./ids";
import type { CatalogV1, CatalogFragmentV1, ProvenanceRef } from "./model";

const put = <K extends string, V>(record: Record<K, V>, key: K, value: V) => {
  record[key] = value;
};

const expectNullableShapeContains = (
  catalog: CatalogV1,
  nullableShapeId: ReturnType<typeof ShapeSymbolIdSchema.make>,
  expectedInnerShapeId: ReturnType<typeof ShapeSymbolIdSchema.make>,
) => {
  const shape = catalog.symbols[nullableShapeId];
  if (shape?.kind !== "shape" || shape.node.type !== "anyOf") {
    throw new Error("Expected nullable anyOf shape");
  }

  expect(shape.node.items).toContain(expectedInnerShapeId);
};

const docId = DocumentIdSchema.make("doc_primary");
const baseProvenance = (pointer: string): ProvenanceRef[] => [{
  relation: "declared",
  documentId: docId,
  pointer,
}];

const createHttpCatalog = (input: {
  collideIds?: boolean;
  method?: string;
} = {}): CatalogV1 => {
  const catalog = createEmptyCatalogV1();

  const resourceId = ResourceIdSchema.make("res_primary");
  const scopeId = ScopeIdSchema.make("scope_service");
  const authSchemeId = SecuritySchemeSymbolIdSchema.make("sym_security_oauth");
  const bodyShapeId = ShapeSymbolIdSchema.make("shape_event_body");
  const resultShapeId = ShapeSymbolIdSchema.make("shape_event_result");
  const stringShapeId = ShapeSymbolIdSchema.make("shape_string");
  const idPathParamId = ParameterSymbolIdSchema.make("sym_param_path_event_id");
  const calendarParamId = ParameterSymbolIdSchema.make("sym_param_path_calendar_id");
  const queryParamId = ParameterSymbolIdSchema.make(
    input.collideIds ? "sym_param_query_id" : "sym_param_query_send_updates",
  );
  const requestBodyId = RequestBodySymbolIdSchema.make("sym_request_body_event");
  const responseId = ResponseSymbolIdSchema.make("sym_response_200");
  const responseSetId = ResponseSetIdSchema.make("response_set_events_update");
  const executableId = ExecutableIdSchema.make("exec_http_events_update");
  const capabilityId = CapabilityIdSchema.make("cap_events_update");
  const exampleId = ExampleSymbolIdSchema.make("sym_example_event_body");

  put(catalog.documents as Record<typeof docId, CatalogV1["documents"][typeof docId]>, docId, {
    id: docId,
    kind: "openapi",
    title: "Calendar API",
    fetchedAt: "2026-03-14T00:00:00.000Z",
    rawRef: "memory://calendar/openapi.json",
  });

  put(catalog.resources as Record<typeof resourceId, CatalogV1["resources"][typeof resourceId]>, resourceId, {
    id: resourceId,
    documentId: docId,
    canonicalUri: "https://example.test/openapi.json",
    baseUri: "https://example.test/openapi.json",
    anchors: {},
    dynamicAnchors: {},
    synthetic: false,
    provenance: baseProvenance("#"),
  });

  put(catalog.scopes as Record<typeof scopeId, CatalogV1["scopes"][typeof scopeId]>, scopeId, {
    id: scopeId,
    kind: "service",
    name: "Calendar",
    namespace: "google.calendar",
    docs: {
      summary: "Calendar service",
      description: "Manage calendar events.",
    },
    synthetic: false,
    provenance: baseProvenance("#/servers/0"),
  });

  put(catalog.symbols as Record<typeof authSchemeId, CatalogV1["symbols"][typeof authSchemeId]>, authSchemeId, {
    id: authSchemeId,
    kind: "securityScheme",
    schemeType: "oauth2",
    docs: {
      summary: "OAuth 2.0",
    },
    oauth: {
      scopes: {
        "calendar.events": "Manage calendar events",
      },
    },
    synthetic: false,
    provenance: baseProvenance("#/components/securitySchemes/oauth2"),
  });

  put(catalog.symbols as Record<typeof stringShapeId, CatalogV1["symbols"][typeof stringShapeId]>, stringShapeId, {
    id: stringShapeId,
    kind: "shape",
    resourceId,
    title: "String",
    node: {
      type: "scalar",
      scalar: "string",
    },
    synthetic: false,
    provenance: baseProvenance("#/components/schemas/String"),
  });

  put(catalog.symbols as Record<typeof bodyShapeId, CatalogV1["symbols"][typeof bodyShapeId]>, bodyShapeId, {
    id: bodyShapeId,
    kind: "shape",
    resourceId,
    title: "EventUpdateBody",
    node: {
      type: "object",
      fields: {
        summary: {
          shapeId: stringShapeId,
        },
      },
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/components/schemas/EventUpdateBody"),
  });

  put(catalog.symbols as Record<typeof resultShapeId, CatalogV1["symbols"][typeof resultShapeId]>, resultShapeId, {
    id: resultShapeId,
    kind: "shape",
    resourceId,
    title: "Event",
    node: {
      type: "object",
      fields: {
        id: {
          shapeId: stringShapeId,
        },
        summary: {
          shapeId: stringShapeId,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/components/schemas/Event"),
  });

  put(catalog.symbols as Record<typeof exampleId, CatalogV1["symbols"][typeof exampleId]>, exampleId, {
    id: exampleId,
    kind: "example",
    exampleKind: "value",
    name: "Event body example",
    value: {
      summary: "Team sync",
    },
    synthetic: false,
    provenance: baseProvenance("#/components/examples/EventBody"),
  });

  put(catalog.symbols as Record<typeof calendarParamId, CatalogV1["symbols"][typeof calendarParamId]>, calendarParamId, {
    id: calendarParamId,
    kind: "parameter",
    name: input.collideIds ? "id" : "calendarId",
    location: "path",
    required: true,
    docs: {
      summary: "Calendar identifier",
      description: "The target calendar.",
    },
    schemaShapeId: stringShapeId,
    synthetic: false,
    provenance: baseProvenance("#/paths/~1events~1{calendarId}/parameters/0"),
  });

  put(catalog.symbols as Record<typeof idPathParamId, CatalogV1["symbols"][typeof idPathParamId]>, idPathParamId, {
    id: idPathParamId,
    kind: "parameter",
    name: "eventId",
    location: "path",
    required: true,
    docs: {
      summary: "Event identifier",
    },
    schemaShapeId: stringShapeId,
    synthetic: false,
    provenance: baseProvenance("#/paths/~1events~1{eventId}/parameters/0"),
  });

  put(catalog.symbols as Record<typeof queryParamId, CatalogV1["symbols"][typeof queryParamId]>, queryParamId, {
    id: queryParamId,
    kind: "parameter",
    name: input.collideIds ? "id" : "sendUpdates",
    location: "query",
    docs: {
      summary: "Notification mode",
    },
    schemaShapeId: stringShapeId,
    synthetic: false,
    provenance: baseProvenance("#/paths/~1events/parameters/0"),
  });

  put(catalog.symbols as Record<typeof requestBodyId, CatalogV1["symbols"][typeof requestBodyId]>, requestBodyId, {
    id: requestBodyId,
    kind: "requestBody",
    required: true,
    docs: {
      summary: "Event payload",
    },
    contents: [
      {
        mediaType: "application/json",
        shapeId: bodyShapeId,
        exampleIds: [exampleId],
      },
    ],
    synthetic: false,
    provenance: baseProvenance("#/paths/~1events/requestBody"),
  });

  put(catalog.symbols as Record<typeof responseId, CatalogV1["symbols"][typeof responseId]>, responseId, {
    id: responseId,
    kind: "response",
    docs: {
      summary: "Updated event",
    },
    contents: [
      {
        mediaType: "application/json",
        shapeId: resultShapeId,
      },
    ],
    synthetic: false,
    provenance: baseProvenance("#/paths/~1events/responses/200"),
  });

  put(catalog.responseSets as Record<typeof responseSetId, CatalogV1["responseSets"][typeof responseSetId]>, responseSetId, {
    id: responseSetId,
    variants: [
      {
        match: {
          kind: "exact",
          status: 200,
        },
        responseId,
        traits: ["success"],
      },
    ],
    synthetic: false,
    provenance: baseProvenance("#/paths/~1events/responses"),
  });

  put(catalog.executables as Record<typeof executableId, CatalogV1["executables"][typeof executableId]>, executableId, {
    id: executableId,
    protocol: "http",
    capabilityId,
    scopeId,
    method: input.method ?? "PATCH",
    pathTemplate: "/calendars/{calendarId}/events/{eventId}",
    pathParameterIds: [calendarParamId, idPathParamId],
    queryParameterIds: [queryParamId],
    requestBodyId,
    responseSetId,
    synthetic: false,
    provenance: baseProvenance("#/paths/~1events/patch"),
  });

  put(catalog.capabilities as Record<typeof capabilityId, CatalogV1["capabilities"][typeof capabilityId]>, capabilityId, {
    id: capabilityId,
    serviceScopeId: scopeId,
    surface: {
      toolPath: ["google", "calendar", "events", "update"],
      title: "Update event",
      summary: "Update a calendar event.",
      description: "Updates an existing event by ID.",
      tags: ["calendar", "events"],
    },
    semantics: {
      effect: "write",
      safe: false,
      idempotent: false,
      destructive: false,
    },
    auth: {
      kind: "scheme",
      schemeId: authSchemeId,
      scopes: ["calendar.events"],
    },
    interaction: {
      approval: {
        mayRequire: true,
        reasons: ["write"],
      },
      elicitation: {
        mayRequest: false,
      },
      resume: {
        supported: true,
      },
    },
    executableIds: [executableId],
    preferredExecutableId: executableId,
    synthetic: false,
    provenance: baseProvenance("#/paths/~1events/patch"),
  });

  return catalog;
};

const createGraphqlCatalog = (): CatalogV1 => {
  const catalog = createEmptyCatalogV1();

  const resourceId = ResourceIdSchema.make("res_graphql");
  const scopeId = ScopeIdSchema.make("scope_graphql_service");
  const argShapeId = ShapeSymbolIdSchema.make("shape_graphql_args");
  const inputShapeId = ShapeSymbolIdSchema.make("shape_graphql_input");
  const selectShapeId = ShapeSymbolIdSchema.make("shape_graphql_select");
  const resultShapeId = ShapeSymbolIdSchema.make("shape_graphql_result");
  const stringShapeId = ShapeSymbolIdSchema.make("shape_graphql_string");
  const responseId = ResponseSymbolIdSchema.make("sym_graphql_response");
  const responseSetId = ResponseSetIdSchema.make("response_set_graphql");
  const executableId = ExecutableIdSchema.make("exec_graphql_update");
  const capabilityId = CapabilityIdSchema.make("cap_graphql_update");

  put(catalog.documents as Record<typeof docId, CatalogV1["documents"][typeof docId]>, docId, {
    id: docId,
    kind: "graphql-schema",
    title: "GraphQL schema",
    fetchedAt: "2026-03-14T00:00:00.000Z",
    rawRef: "memory://graphql/schema.json",
  });

  put(catalog.resources as Record<typeof resourceId, CatalogV1["resources"][typeof resourceId]>, resourceId, {
    id: resourceId,
    documentId: docId,
    canonicalUri: "https://example.test/graphql",
    baseUri: "https://example.test/graphql",
    anchors: {},
    dynamicAnchors: {},
    synthetic: false,
    provenance: baseProvenance("#"),
  });

  put(catalog.scopes as Record<typeof scopeId, CatalogV1["scopes"][typeof scopeId]>, scopeId, {
    id: scopeId,
    kind: "service",
    name: "GraphQL",
    synthetic: false,
    provenance: baseProvenance("#/schema"),
  });

  put(catalog.symbols as Record<typeof stringShapeId, CatalogV1["symbols"][typeof stringShapeId]>, stringShapeId, {
    id: stringShapeId,
    kind: "shape",
    resourceId,
    title: "String",
    node: {
      type: "scalar",
      scalar: "string",
    },
    synthetic: false,
    provenance: baseProvenance("#/$defs/String"),
  });

  put(catalog.symbols as Record<typeof inputShapeId, CatalogV1["symbols"][typeof inputShapeId]>, inputShapeId, {
    id: inputShapeId,
    kind: "shape",
    resourceId,
    title: "UserInput",
    node: {
      type: "object",
      fields: {
        name: {
          shapeId: stringShapeId,
        },
      },
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/$defs/UserInput"),
  });

  put(catalog.symbols as Record<typeof argShapeId, CatalogV1["symbols"][typeof argShapeId]>, argShapeId, {
    id: argShapeId,
    kind: "shape",
    resourceId,
    title: "UpdateUserArgs",
    node: {
      type: "object",
      fields: {
        id: {
          shapeId: stringShapeId,
        },
        input: {
          shapeId: inputShapeId,
        },
      },
      required: ["id", "input"],
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/$defs/UpdateUserArgs"),
  });

  put(catalog.symbols as Record<typeof selectShapeId, CatalogV1["symbols"][typeof selectShapeId]>, selectShapeId, {
    id: selectShapeId,
    kind: "shape",
    resourceId,
    title: "UserSelection",
    node: {
      type: "object",
      fields: {
        id: {
          shapeId: stringShapeId,
        },
        name: {
          shapeId: stringShapeId,
        },
      },
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/$defs/UserSelection"),
  });

  put(catalog.symbols as Record<typeof resultShapeId, CatalogV1["symbols"][typeof resultShapeId]>, resultShapeId, {
    id: resultShapeId,
    kind: "shape",
    resourceId,
    title: "User",
    node: {
      type: "object",
      fields: {
        id: {
          shapeId: stringShapeId,
        },
        name: {
          shapeId: stringShapeId,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/$defs/User"),
  });

  put(catalog.symbols as Record<typeof responseId, CatalogV1["symbols"][typeof responseId]>, responseId, {
    id: responseId,
    kind: "response",
    contents: [
      {
        mediaType: "application/json",
        shapeId: resultShapeId,
      },
    ],
    synthetic: false,
    provenance: baseProvenance("#/responses/default"),
  });

  put(catalog.responseSets as Record<typeof responseSetId, CatalogV1["responseSets"][typeof responseSetId]>, responseSetId, {
    id: responseSetId,
    variants: [
      {
        match: {
          kind: "default",
        },
        responseId,
        traits: ["success"],
      },
    ],
    synthetic: false,
    provenance: baseProvenance("#/responses"),
  });

  put(catalog.executables as Record<typeof executableId, CatalogV1["executables"][typeof executableId]>, executableId, {
    id: executableId,
    protocol: "graphql",
    capabilityId,
    scopeId,
    operationType: "mutation",
    rootField: "updateUser",
    argumentShapeId: argShapeId,
    resultShapeId,
    selectionShapeId: selectShapeId,
    selectionMode: "caller",
    responseSetId,
    synthetic: false,
    provenance: baseProvenance("#/mutations/updateUser"),
  });

  put(catalog.capabilities as Record<typeof capabilityId, CatalogV1["capabilities"][typeof capabilityId]>, capabilityId, {
    id: capabilityId,
    serviceScopeId: scopeId,
    surface: {
      toolPath: ["graphql", "users", "update"],
      title: "Update user",
      summary: "Update a user.",
    },
    semantics: {
      effect: "write",
    },
    auth: {
      kind: "none",
    },
    interaction: {
      approval: {
        mayRequire: true,
        reasons: ["write"],
      },
      elicitation: {
        mayRequest: false,
      },
      resume: {
        supported: false,
      },
    },
    executableIds: [executableId],
    preferredExecutableId: executableId,
    synthetic: false,
    provenance: baseProvenance("#/mutations/updateUser"),
  });

  return catalog;
};

describe("IR catalog", () => {
  it("decodes a snapshot through the canonical schema", () => {
    const catalog = createHttpCatalog();
    const snapshot = createCatalogSnapshotV1({
      import: {
        sourceKind: "openapi",
        adapterKey: "openapi",
        importerVersion: "1.0.0",
        importedAt: "2026-03-14T00:00:00.000Z",
        sourceConfigHash: "hash_source",
      },
      catalog,
    });

    const decoded = decodeCatalogSnapshotV1(snapshot);
    expect(decoded.version).toBe("ir.v1.snapshot");
    expect(decoded.catalog.capabilities[CapabilityIdSchema.make("cap_events_update")]?.surface.title).toBe(
      "Update event",
    );
  });

  it("merges fragments and emits diagnostics on conflicting IDs", () => {
    const fragmentA: CatalogFragmentV1 = {
      version: "ir.v1.fragment",
      documents: {
        [docId]: {
          id: docId,
          kind: "openapi",
          title: "A",
          fetchedAt: "2026-03-14T00:00:00.000Z",
          rawRef: "memory://a",
        },
      },
    };
    const fragmentB: CatalogFragmentV1 = {
      version: "ir.v1.fragment",
      documents: {
        [docId]: {
          id: docId,
          kind: "openapi",
          title: "B",
          fetchedAt: "2026-03-14T00:00:00.000Z",
          rawRef: "memory://b",
        },
      },
    };

    const merged = mergeCatalogFragments([fragmentA, fragmentB]);
    expect(merged.documents[docId]?.title).toBe("A");
    expect(Object.values(merged.diagnostics).some((diagnostic) => diagnostic.code === "merge_conflict_preserved_first")).toBe(true);
  });

  it("reports invariant violations for unresolved shapes without diagnostics", () => {
    const catalog = createEmptyCatalogV1();
    const shapeId = ShapeSymbolIdSchema.make("shape_unresolved");

    put(catalog.documents as Record<typeof docId, CatalogV1["documents"][typeof docId]>, docId, {
      id: docId,
      kind: "custom",
      fetchedAt: "2026-03-14T00:00:00.000Z",
      rawRef: "memory://custom",
    });

    put(catalog.symbols as Record<typeof shapeId, CatalogV1["symbols"][typeof shapeId]>, shapeId, {
      id: shapeId,
      kind: "shape",
      title: "Unresolved",
      node: {
        type: "unknown",
        reason: "unresolved reference #/components/schemas/Missing",
      },
      synthetic: false,
      provenance: baseProvenance("#/components/schemas/Missing"),
    });

    const violations = validateCatalogInvariants(catalog);
    expect(violations.map((violation) => violation.code)).toContain("missing_resource_context");
    expect(violations.map((violation) => violation.code)).toContain("missing_unresolved_ref_diagnostic");
  });

  it("projects HTTP capabilities into ergonomic call and result shapes", () => {
    const projected = projectCatalogForAgentSdk({
      catalog: createHttpCatalog(),
    });

    const descriptor = projected.toolDescriptors[CapabilityIdSchema.make("cap_events_update")];
    expect(descriptor.toolPath).toEqual(["google", "calendar", "events", "update"]);

    const callShape = projected.catalog.symbols[descriptor.callShapeId];
    expect(callShape?.kind).toBe("shape");
    if (callShape?.kind !== "shape" || callShape.node.type !== "object") {
      throw new Error("Expected projected call shape object");
    }

    expect(Object.keys(callShape.node.fields)).toEqual([
      "calendarId",
      "eventId",
      "sendUpdates",
      "body",
    ]);
    expect(callShape.node.required).toEqual(["calendarId", "eventId", "body"]);

    const resultShape = descriptor.resultShapeId
      ? projected.catalog.symbols[descriptor.resultShapeId]
      : undefined;
    if (resultShape?.kind !== "shape" || resultShape.node.type !== "object") {
      throw new Error("Expected projected HTTP result envelope");
    }
    expect(Object.keys(resultShape.node.fields)).toEqual(["data", "error", "headers", "status"]);
    expectNullableShapeContains(
      projected.catalog,
      resultShape.node.fields.data.shapeId,
      ShapeSymbolIdSchema.make("shape_event_result"),
    );

    const searchDoc = projected.searchDocs[CapabilityIdSchema.make("cap_events_update")];
    expect(searchDoc.authHints).toContain("oauth2");
    expect(searchDoc.tags).toEqual(["calendar", "events"]);
  });

  it("groups colliding HTTP parameter names into path/query containers", () => {
    const projected = projectCatalogForAgentSdk({
      catalog: createHttpCatalog({ collideIds: true }),
    });

    const descriptor = projected.toolDescriptors[CapabilityIdSchema.make("cap_events_update")];
    const callShape = projected.catalog.symbols[descriptor.callShapeId];
    if (callShape?.kind !== "shape" || callShape.node.type !== "object") {
      throw new Error("Expected projected call shape object");
    }

    expect(Object.keys(callShape.node.fields)).toContain("path");
    expect(Object.keys(callShape.node.fields)).toContain("query");
    expect(Object.keys(callShape.node.fields)).not.toContain("id");
    expect(Object.values(projected.catalog.diagnostics).some((diagnostic) => diagnostic.code === "projection_collision_grouped_fields")).toBe(true);
  });

  it("keeps GraphQL selection explicit for caller-driven outputs", () => {
    const projected = projectCatalogForAgentSdk({
      catalog: createGraphqlCatalog(),
    });

    const descriptor = projected.toolDescriptors[CapabilityIdSchema.make("cap_graphql_update")];
    const callShape = projected.catalog.symbols[descriptor.callShapeId];
    if (callShape?.kind !== "shape" || callShape.node.type !== "object") {
      throw new Error("Expected projected GraphQL call shape object");
    }

    expect(Object.keys(callShape.node.fields)).toEqual(["id", "input", "select"]);
    const resultShape = descriptor.resultShapeId
      ? projected.catalog.symbols[descriptor.resultShapeId]
      : undefined;
    if (resultShape?.kind !== "shape" || resultShape.node.type !== "object") {
      throw new Error("Expected projected GraphQL result envelope");
    }
    expect(Object.keys(resultShape.node.fields)).toEqual(["data", "error", "headers", "status"]);
    expectNullableShapeContains(
      projected.catalog,
      resultShape.node.fields.data.shapeId,
      ShapeSymbolIdSchema.make("shape_graphql_result"),
    );
  });

  it("builds inspect views and invocation plans from the projected graph", () => {
    const projected = projectCatalogForAgentSdk({
      catalog: createHttpCatalog(),
    });
    const capabilityId = CapabilityIdSchema.make("cap_events_update");
    const descriptor = projected.toolDescriptors[capabilityId];
    const shallow = projectSymbolShallowView(projected.catalog, descriptor.callShapeId);
    const expanded = projectSymbolExpandedView(projected.catalog, descriptor.callShapeId);
    const plan = buildInvocationPlan({
      catalog: projected.catalog,
      capabilityId,
      connectionBindingId: "binding_primary",
      resolvedEndpoint: "https://example.test",
      requestPlan: {
        method: "PATCH",
        path: "/calendars/primary/events/abc",
      },
    });

    expect(shallow.edges.some((edge) => edge.label === "field:body")).toBe(true);
    expect(expanded.symbol.id).toBe(descriptor.callShapeId);
    expect(plan.connectionBindingId).toBe("binding_primary");
    expect(plan.resolvedScopeChain).toEqual([ScopeIdSchema.make("scope_service")]);
    expect(plan.resolvedInteraction?.requiresApproval).toBe(true);
  });
});
