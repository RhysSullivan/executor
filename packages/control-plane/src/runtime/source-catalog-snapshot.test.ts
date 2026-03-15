import { describe, expect, it } from "@effect/vitest";

import type { Source } from "#schema";

import {
  buildGraphqlToolPresentation,
  compileGraphqlToolDefinitions,
  type GraphqlToolManifest,
} from "./graphql-tools";
import {
  createGoogleDiscoveryCatalogSnapshot,
  createGraphqlCatalogSnapshot,
  createMcpCatalogSnapshot,
  createOpenApiCatalogSnapshot,
} from "./source-catalog-snapshot";

const baseSource: Source = {
  id: "src_calendar" as Source["id"],
  workspaceId: "ws_test" as Source["workspaceId"],
  name: "Calendar",
  kind: "openapi",
  endpoint: "https://api.example.test",
  status: "connected",
  enabled: true,
  namespace: "google.calendar",
  bindingVersion: 1,
  binding: {
    specUrl: "https://api.example.test/openapi.json",
    defaultHeaders: null,
  },
  importAuthPolicy: "none",
  importAuth: { kind: "none" },
  auth: { kind: "none" },
  sourceHash: "hash_source",
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("source-catalog-snapshot", () => {
  it("builds an HTTP capability graph from OpenAPI operation inputs", () => {
    const snapshot = createOpenApiCatalogSnapshot({
      source: baseSource,
      documents: [{
          documentKind: "openapi",
          documentKey: "https://api.example.test/openapi.json",
          contentText: "{}",
          fetchedAt: 1,
        }],
      operations: [{
          toolId: "events.update",
          title: "Update event",
          description: "Update a calendar event",
          effect: "write",
          inputSchema: {
            type: "object",
            properties: {
              calendarId: { type: "string", description: "Calendar ID" },
              eventId: { type: "string" },
              sendUpdates: { type: "string", enum: ["all", "none"] },
              body: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                },
              },
            },
            required: ["calendarId", "eventId", "body"],
          },
          outputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              summary: { type: "string" },
            },
            required: ["id"],
          },
          providerData: {
            kind: "openapi",
            toolId: "events.update",
            rawToolId: "events.update",
            group: "events",
            leaf: "update",
            tags: ["events"],
            method: "patch",
            path: "/calendars/{calendarId}/events/{eventId}",
            operationHash: "op_hash",
            invocation: {
              method: "patch",
              pathTemplate: "/calendars/{calendarId}/events/{eventId}",
              parameters: [
                { name: "calendarId", location: "path", required: true },
                { name: "eventId", location: "path", required: true },
                { name: "sendUpdates", location: "query", required: false },
              ],
              requestBody: {
                required: true,
                contentTypes: ["application/json"],
              },
            },
            documentation: {
              summary: "Update event",
              parameters: [
                {
                  name: "calendarId",
                  location: "path",
                  required: true,
                  description: "Calendar identifier",
                },
              ],
              requestBody: {
                description: "Event patch body",
              },
              response: {
                statusCode: "200",
                description: "Updated event",
                contentTypes: ["application/json"],
              },
            },
          },
        }],
    });

    expect(snapshot.version).toBe("ir.v1.snapshot");
    expect(Object.keys(snapshot.catalog.capabilities)).toHaveLength(1);

    const capability = Object.values(snapshot.catalog.capabilities)[0]!;
    const executable = Object.values(snapshot.catalog.executables)[0]!;
    const responseSet = Object.values(snapshot.catalog.responseSets)[0]!;

    expect(capability.surface.toolPath).toEqual(["google", "calendar", "events", "update"]);
    expect(capability.semantics.effect).toBe("write");
    expect(capability.auth.kind).toBe("none");
    expect(executable.protocol).toBe("http");
    expect(executable.method).toBe("PATCH");
    expect(executable.pathTemplate).toBe("/calendars/{calendarId}/events/{eventId}");
    expect(executable.native).toBeUndefined();
    expect(capability.native).toBeUndefined();
    expect(responseSet.variants).toHaveLength(1);
  });

  it("projects OpenAPI auth requirements and response variants into IR", () => {
    const snapshot = createOpenApiCatalogSnapshot({
      source: baseSource,
      documents: [{
        documentKind: "openapi",
        documentKey: "https://api.example.test/openapi.json",
        contentText: "{}",
        fetchedAt: 1,
      }],
      operations: [{
        toolId: "projects.get",
        title: "Get project",
        description: "Get a project",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "string",
            },
          },
          required: ["projectId"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
        providerData: {
          kind: "openapi",
          toolId: "projects.get",
          rawToolId: "projects.get",
          group: "projects",
          leaf: "get",
          tags: ["projects"],
          method: "get",
          path: "/projects/{projectId}",
          operationHash: "op_hash_projects_get",
          invocation: {
            method: "get",
            pathTemplate: "/projects/{projectId}",
            parameters: [
              { name: "projectId", location: "path", required: true },
            ],
            requestBody: null,
          },
          documentation: {
            summary: "Get project",
            parameters: [],
            response: {
              statusCode: "200",
              description: "Project",
              contentTypes: ["application/json"],
            },
          },
          authRequirement: {
            kind: "anyOf",
            items: [
              {
                kind: "scheme",
                schemeName: "bearerToken",
              },
              {
                kind: "scheme",
                schemeName: "apiKeyHeader",
              },
            ],
          },
          securitySchemes: [
            {
              schemeName: "bearerToken",
              schemeType: "http",
              description: "Bearer auth.",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
            {
              schemeName: "apiKeyHeader",
              schemeType: "apiKey",
              placementIn: "header",
              placementName: "x-api-key",
            },
          ],
          responses: [
            {
              statusCode: "200",
              description: "Project",
              contentTypes: ["application/json"],
              schema: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                  },
                },
                required: ["id"],
                additionalProperties: false,
              },
            },
            {
              statusCode: "404",
              description: "Missing",
              contentTypes: ["application/json"],
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "string",
                  },
                },
                required: ["error"],
                additionalProperties: false,
              },
            },
          ],
        },
      }],
    });

    const capability = Object.values(snapshot.catalog.capabilities)[0]!;
    const executable = Object.values(snapshot.catalog.executables)[0]!;
    const responseSet = Object.values(snapshot.catalog.responseSets)[0]!;
    const securitySchemes = Object.values(snapshot.catalog.symbols).filter((symbol) => symbol.kind === "securityScheme");

    expect(capability.auth).toMatchObject({
      kind: "anyOf",
    });
    expect(executable.native).toBeUndefined();
    expect(capability.native).toBeUndefined();
    expect(securitySchemes).toHaveLength(2);
    expect(
      responseSet.variants.map((variant) => variant.match),
    ).toEqual([
      { kind: "exact", status: 200 },
      { kind: "exact", status: 404 },
    ]);
  });

  it("projects OpenAPI servers, parameter serialization, and response headers into IR", () => {
    const snapshot = createOpenApiCatalogSnapshot({
      source: baseSource,
      documents: [{
        documentKind: "openapi",
        documentKey: "https://api.example.test/openapi.json",
        contentText: "{}",
        fetchedAt: 1,
      }],
      operations: [{
        toolId: "items.get",
        title: "Get item",
        description: "Get an item",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: {
            itemId: {
              type: "array",
              items: {
                type: "string",
              },
            },
            filter: {
              type: "object",
              additionalProperties: {
                type: "string",
              },
            },
            body: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                },
              },
            },
          },
          required: ["itemId"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
        providerData: {
          kind: "openapi",
          toolId: "items.get",
          rawToolId: "items.get",
          group: "items",
          leaf: "get",
          tags: ["items"],
          method: "get",
          path: "/items/{itemId}",
          operationHash: "op_hash_items_get",
          invocation: {
            method: "get",
            pathTemplate: "/items/{itemId}",
            parameters: [
              {
                name: "itemId",
                location: "path",
                required: true,
                style: "label",
                explode: true,
              },
              {
                name: "filter",
                location: "query",
                required: false,
                style: "deepObject",
                explode: true,
              },
            ],
            requestBody: {
              required: false,
              contentTypes: ["application/x-www-form-urlencoded", "application/json"],
              contents: [
                {
                  mediaType: "application/x-www-form-urlencoded",
                  schema: {
                    type: "object",
                    properties: {
                      title: {
                        type: "string",
                      },
                    },
                  },
                },
                {
                  mediaType: "application/json",
                  schema: {
                    type: "object",
                    properties: {
                      title: {
                        type: "string",
                      },
                    },
                  },
                },
              ],
            },
          },
          documentation: null,
          documentServers: [{
            url: "https://api.example.test/{version}",
            variables: {
              version: "v1",
            },
          }],
          servers: [{
            url: "https://regional.example.test/base",
          }],
          responses: [
            {
              statusCode: "200",
              description: "Item",
              contentTypes: ["application/json", "text/plain"],
              contents: [
                {
                  mediaType: "application/json",
                  schema: {
                    type: "object",
                    properties: {
                      id: {
                        type: "string",
                      },
                    },
                    required: ["id"],
                    additionalProperties: false,
                  },
                },
                {
                  mediaType: "text/plain",
                  schema: {
                    type: "string",
                  },
                },
              ],
              headers: [
                {
                  name: "x-next-cursor",
                  description: "Next cursor.",
                  schema: {
                    type: "string",
                  },
                },
              ],
            },
          ],
        },
      }],
    });

    const capability = Object.values(snapshot.catalog.capabilities)[0]!;
    const executable = Object.values(snapshot.catalog.executables)[0]!;
    const serviceScope = snapshot.catalog.scopes[capability.serviceScopeId]!;
    const operationScope = snapshot.catalog.scopes[executable.scopeId]!;
    const pathParameter = Object.values(snapshot.catalog.symbols).find((symbol) =>
      symbol.kind === "parameter" && symbol.name === "itemId"
    );
    const queryParameter = Object.values(snapshot.catalog.symbols).find((symbol) =>
      symbol.kind === "parameter" && symbol.name === "filter"
    );
    const requestBody = executable.requestBodyId
      ? snapshot.catalog.symbols[executable.requestBodyId]
      : undefined;
    const response = Object.values(snapshot.catalog.symbols).find((symbol) => symbol.kind === "response");

    expect(serviceScope.defaults?.servers).toEqual([
      {
        url: "https://api.example.test/{version}",
        variables: {
          version: "v1",
        },
      },
    ]);
    expect(operationScope.defaults?.servers).toEqual([
      {
        url: "https://regional.example.test/base",
      },
    ]);
    expect(pathParameter).toMatchObject({
      kind: "parameter",
      style: "label",
      explode: true,
    });
    expect(queryParameter).toMatchObject({
      kind: "parameter",
      style: "deepObject",
      explode: true,
    });
    expect(requestBody?.kind).toBe("requestBody");
    expect(requestBody?.kind === "requestBody" ? requestBody.contents.map((content) => content.mediaType) : []).toEqual([
      "application/x-www-form-urlencoded",
      "application/json",
    ]);
    expect(response?.kind).toBe("response");
    expect(response?.kind === "response" ? response.headerIds?.length : 0).toBe(1);
    expect(response?.kind === "response" ? response.contents?.map((content) => content.mediaType) : []).toEqual([
      "application/json",
      "text/plain",
    ]);
  });

  it("imports Google Discovery scopes as auth requirements", () => {
    const snapshot = createGoogleDiscoveryCatalogSnapshot({
      source: {
        ...baseSource,
        kind: "google_discovery",
        namespace: "google.drive",
      },
      documents: [],
      operations: [{
          toolId: "files.list",
          title: "List files",
          description: "List drive files",
          effect: "read",
          inputSchema: { type: "object", properties: { pageSize: { type: "integer" } } },
          outputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } } } },
          providerData: {
            kind: "google_discovery",
            service: "drive",
            version: "v3",
            toolId: "files.list",
            rawToolId: "files.list",
            methodId: "drive.files.list",
            group: "files",
            leaf: "list",
            invocation: {
              method: "get",
              path: "/drive/v3/files",
              flatPath: null,
              rootUrl: "https://www.googleapis.com/",
              servicePath: "drive/v3/",
              parameters: [],
              requestSchemaId: null,
              responseSchemaId: "FileList",
              scopes: ["https://www.googleapis.com/auth/drive.readonly"],
              scopeDescriptions: {
                "https://www.googleapis.com/auth/drive.readonly": "View your Google Drive files.",
              },
              supportsMediaUpload: false,
              supportsMediaDownload: false,
            },
          },
        }],
    });

    const capability = Object.values(snapshot.catalog.capabilities)[0]!;
    const executable = Object.values(snapshot.catalog.executables)[0]!;
    const securityScheme = Object.values(snapshot.catalog.symbols).find((symbol) => symbol.kind === "securityScheme");

    expect(capability.auth.kind).toBe("scheme");
    expect(capability.native).toBeUndefined();
    expect(executable.native?.[0]?.value).toEqual({
      invocation: {
        rootUrl: "https://www.googleapis.com/",
        servicePath: "drive/v3/",
      },
    });
    expect(securityScheme?.kind).toBe("securityScheme");
    expect(securityScheme?.kind === "securityScheme" ? securityScheme.oauth?.scopes : undefined).toEqual({
      "https://www.googleapis.com/auth/drive.readonly": "View your Google Drive files.",
    });
  });

  it("deduplicates structurally identical JSON schema shapes across operations", () => {
    const repeatedObjectSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    };

    const snapshot = createOpenApiCatalogSnapshot({
      source: baseSource,
      documents: [{
        documentKind: "openapi",
        documentKey: "https://api.example.test/openapi.json",
        contentText: "{}",
        fetchedAt: 1,
      }],
      operations: [
        {
          toolId: "events.get",
          title: "Get event",
          description: "Get an event",
          effect: "read",
          inputSchema: {
            type: "object",
            properties: {
              eventId: { type: "string" },
            },
          },
          outputSchema: repeatedObjectSchema,
          providerData: {
            kind: "openapi",
            toolId: "events.get",
            rawToolId: "events.get",
            group: "events",
            leaf: "get",
            tags: ["events"],
            method: "get",
            path: "/events/{eventId}",
            operationHash: "op_hash_get",
            invocation: {
              method: "get",
              pathTemplate: "/events/{eventId}",
              parameters: [
                { name: "eventId", location: "path", required: true },
              ],
              requestBody: null,
            },
            documentation: null,
          },
        },
        {
          toolId: "events.list",
          title: "List events",
          description: "List events",
          effect: "read",
          inputSchema: {
            type: "object",
            properties: {
              pageToken: { type: "string" },
            },
          },
          outputSchema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: repeatedObjectSchema,
              },
            },
            additionalProperties: false,
          },
          providerData: {
            kind: "openapi",
            toolId: "events.list",
            rawToolId: "events.list",
            group: "events",
            leaf: "list",
            tags: ["events"],
            method: "get",
            path: "/events",
            operationHash: "op_hash_list",
            invocation: {
              method: "get",
              pathTemplate: "/events",
              parameters: [],
              requestBody: null,
            },
            documentation: null,
          },
        },
      ],
    });

    const shapes = Object.values(snapshot.catalog.symbols).filter((symbol) => symbol.kind === "shape");
    const stringScalars = shapes.filter((symbol) =>
      symbol.node.type === "scalar" && symbol.node.scalar === "string" && symbol.node.format === undefined
    );
    const repeatedObjects = shapes.filter((symbol) =>
      symbol.node.type === "object"
      && Object.keys(symbol.node.fields).length === 2
      && symbol.node.fields.id !== undefined
      && symbol.node.fields.name !== undefined
      && symbol.node.additionalProperties === false
      && symbol.node.required?.length === 1
      && symbol.node.required[0] === "id"
    );
    expect(stringScalars).toHaveLength(1);
    expect(repeatedObjects.length).toBeGreaterThan(0);
  });

  it("converts GraphQL field operations into GraphQL executables", () => {
    const snapshot = createGraphqlCatalogSnapshot({
      source: {
        ...baseSource,
        kind: "graphql",
        namespace: "github",
      },
      documents: [],
      operations: [{
          toolId: "viewer",
          title: "Viewer",
          description: "Load the current viewer",
          effect: "read",
          inputSchema: { type: "object", properties: {} },
          outputSchema: { type: "object", properties: { login: { type: "string" } } },
          providerData: {
            kind: "graphql",
            toolKind: "field",
            toolId: "viewer",
            rawToolId: "viewer",
            group: "query",
            leaf: "viewer",
            fieldName: "viewer",
            operationType: "query",
            operationName: "ViewerQuery",
            operationDocument: "query ViewerQuery { viewer { login } }",
            queryTypeName: "Query",
            mutationTypeName: null,
            subscriptionTypeName: null,
          },
        }],
    });

    const executable = Object.values(snapshot.catalog.executables)[0]!;

    expect(executable.protocol).toBe("graphql");
    expect(executable.operationType).toBe("query");
    expect(executable.rootField).toBe("viewer");
    expect(executable.selectionMode).toBe("fixed");
    expect(executable.native).toMatchObject([{
      kind: "graphql_provider_data",
    }]);
  });

  it("projects MCP metadata into capability semantics", () => {
    const snapshot = createMcpCatalogSnapshot({
      source: {
        ...baseSource,
        kind: "mcp",
        namespace: "workspace.mcp",
      },
      documents: [{
        documentKind: "mcp_manifest",
        documentKey: "https://mcp.example.test",
        contentText: "{}",
        fetchedAt: 1,
      }],
      operations: [{
        toolId: "memory.read_file",
        title: "Read File",
        description: "Read a file from memory",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
        providerData: {
          toolId: "memory.read_file",
          toolName: "read_file",
          displayTitle: "Read File",
          title: "Read File",
          description: "Read a file from memory",
          annotations: {
            title: "Read File (Annotated)",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          execution: {
            taskSupport: "required",
          },
          icons: [{
            src: "https://example.test/icon.png",
          }],
          meta: {
            category: "filesystem",
          },
          rawTool: {
            name: "read_file",
            annotations: {
              readOnlyHint: true,
            },
          },
          server: {
            info: {
              name: "mcp-test-server",
              version: "1.0.0",
              title: "Test Server",
              description: null,
              websiteUrl: null,
              icons: null,
            },
            capabilities: {
              experimental: null,
              logging: false,
              completions: false,
              prompts: null,
              resources: null,
              tools: {
                listChanged: true,
              },
              tasks: {
                list: false,
                cancel: false,
                toolCall: true,
              },
            },
            instructions: "Use carefully.",
            rawInfo: {
              name: "mcp-test-server",
              version: "1.0.0",
            },
            rawCapabilities: {
              tools: {
                listChanged: true,
              },
            },
          },
        },
      }],
    });

    const capability = Object.values(snapshot.catalog.capabilities)[0]!;
    const executable = Object.values(snapshot.catalog.executables)[0]!;

    expect(capability.surface.title).toBe("Read File");
    expect(capability.semantics).toMatchObject({
      effect: "read",
      safe: true,
      idempotent: true,
      destructive: false,
    });
    expect(capability.interaction.resume.supported).toBe(true);
    expect(capability.native).toBeUndefined();
    expect(executable.protocol).toBe("mcp");
    expect(executable.native).toBeUndefined();
  });

  it("materializes GraphQL input refs before importing into IR snapshots", () => {
    const manifest: GraphqlToolManifest = {
      version: 2,
      sourceHash: "hash_graphql",
      queryTypeName: "Query",
      mutationTypeName: "Mutation",
      subscriptionTypeName: null,
      schemaRefTable: {
        "#/$defs/graphql/input/AgentActivityCreatePromptInput": JSON.stringify({
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Prompt text.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        }),
      },
      tools: [{
        kind: "field",
        toolId: "agentActivityCreatePrompt",
        rawToolId: "agentActivityCreatePrompt",
        toolName: "Agent Activity Create Prompt",
        description: "Create a prompt activity.",
        group: "mutation",
        leaf: "agentActivityCreatePrompt",
        fieldName: "agentActivityCreatePrompt",
        operationType: "mutation",
        operationName: "MutationAgentActivityCreatePrompt",
        operationDocument:
          "mutation MutationAgentActivityCreatePrompt($input: AgentActivityCreatePromptInput!) { agentActivityCreatePrompt(input: $input) { success __typename } }",
        searchTerms: ["mutation", "agentActivityCreatePrompt", "input"],
        inputSchema: {
          type: "object",
          properties: {
            input: {
              $ref: "#/$defs/graphql/input/AgentActivityCreatePromptInput",
              description: "Prompt activity input.",
            },
            headers: {
              type: "object",
              additionalProperties: {
                type: "string",
              },
            },
          },
          required: ["input"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            data: {
              type: "object",
              properties: {
                success: {
                  type: "boolean",
                },
              },
              required: ["success"],
              additionalProperties: false,
            },
            errors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  message: {
                    type: "string",
                  },
                },
              },
            },
          },
          required: ["data", "errors"],
          additionalProperties: false,
        },
      }],
    };

    const definition = compileGraphqlToolDefinitions(manifest)[0]!;
    const presentation = buildGraphqlToolPresentation({
      manifest,
      definition,
    });
    const snapshot = createGraphqlCatalogSnapshot({
      source: {
        ...baseSource,
        kind: "graphql",
        namespace: "linear",
      },
      documents: [],
      operations: [{
        toolId: definition.toolId,
        title: definition.name,
        description: definition.description,
        effect: "write",
        inputSchema: presentation.inputSchema,
        outputSchema: presentation.outputSchema,
        providerData: presentation.providerData,
      }],
    });

    expect(presentation.previewInputType).toContain("{ input: {");
    expect(presentation.previewOutputType).not.toContain("unknown[]");

    const executable = Object.values(snapshot.catalog.executables)[0]!;
    const argumentShape = snapshot.catalog.symbols[executable.argumentShapeId];
    expect(argumentShape?.kind).toBe("shape");
    if (!argumentShape || argumentShape.kind !== "shape") {
      throw new Error("Expected argument shape symbol");
    }

    expect(argumentShape.node.type).toBe("object");
    if (argumentShape.node.type !== "object") {
      throw new Error("Expected object argument shape");
    }

    const inputFieldShapeId = argumentShape.node.fields.input?.shapeId;
    expect(inputFieldShapeId).toBeDefined();
    const inputFieldShape =
      inputFieldShapeId === undefined
        ? undefined
        : snapshot.catalog.symbols[inputFieldShapeId];

    expect(inputFieldShape?.kind).toBe("shape");
    if (!inputFieldShape || inputFieldShape.kind !== "shape") {
      throw new Error("Expected GraphQL input field shape");
    }

    expect(inputFieldShape.node.type).toBe("ref");
    expect(
      Object.values(snapshot.catalog.diagnostics).some(
        (diagnostic) =>
          diagnostic.code === "unresolved_ref"
          && diagnostic.message.includes("AgentActivityCreatePromptInput"),
      ),
    ).toBe(false);
  });
});
