import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Effect from "effect/Effect";

import type {
  LoadedSourceCatalogTool,
} from "../catalog/source/runtime";
import {
  inspectionToolDetailFromTool,
} from "../../sources/inspection";

describe("source inspection", () => {
  it.effect("keeps the shared TypeScript contract first-class on tool detail", () =>
    Effect.gen(function* () {
      const detail = yield* inspectionToolDetailFromTool({
      path: "linear.administrableTeams",
      source: {
        id: "linear",
      },
      capability: {
        surface: {
          title: "Administrable Teams",
          summary: "All teams the user can administrate.",
          description: "All teams the user can administrate.",
          tags: ["query"],
        },
        native: [],
      },
      executable: {
        id: "exec_graphql_administrableTeams",
        pluginKey: "graphql",
        bindingVersion: 1,
        binding: {
          operationKind: "query",
          rootTypeName: "Query",
          fieldName: "administrableTeams",
        },
        projection: {
          callShapeId: "shape_call",
          resultDataShapeId: "shape_result_data",
          resultErrorShapeId: "shape_result_error",
          responseSetId: "response_set_1",
        },
        display: {
          protocol: "graphql",
          method: "query",
          pathTemplate: "administrableTeams",
          operationId: "administrableTeams",
          group: "query",
          leaf: "administrableTeams",
          rawToolId: "administrableTeams",
        },
        native: [],
      },
      projectedDescriptor: {
        toolPath: ["linear", "administrableTeams"],
        callShapeId: "shape_call",
        resultShapeId: "shape_result",
        responseSetId: "response_set_1",
      },
      descriptor: {
        inputTypePreview: "{ input: string }",
        outputTypePreview: "{ data: string | null; error: unknown | null; headers: Record<string, string>; status: number | null }",
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
          required: ["input"],
        },
        outputSchema: {
          type: "object",
          properties: {
            data: { type: ["string", "null"] },
          },
          required: ["data"],
        },
      },
      projectedCatalog: {
        version: "ir.v1",
        documents: {},
        resources: {},
        scopes: {},
        capabilities: {},
        executables: {},
        responseSets: {},
        diagnostics: {},
        symbols: {
          shape_call: {
            id: "shape_call",
            kind: "shape",
            resourceId: "res_1",
            title: "AdministrableTeamsCall",
            node: {
              type: "object",
              fields: {
                input: {
                  shapeId: "shape_call_input",
                  docs: {
                    description: "The exact input string to filter by.",
                  },
                },
              },
              required: ["input"],
              additionalProperties: false,
            },
            synthetic: false,
            provenance: [],
          },
          shape_call_input: {
            id: "shape_call_input",
            kind: "shape",
            resourceId: "res_1",
            title: "Input",
            node: {
              type: "scalar",
              scalar: "string",
            },
            synthetic: false,
            provenance: [],
          },
          shape_result: {
            id: "shape_result",
            kind: "shape",
            resourceId: "res_1",
            title: "AdministrableTeamsResult",
            node: {
              type: "object",
              fields: {
                data: {
                  shapeId: "shape_result_data_nullable",
                  docs: {
                    description: "Matching team data when present.",
                  },
                },
                error: {
                  shapeId: "shape_result_error_nullable",
                },
                headers: {
                  shapeId: "shape_result_headers",
                },
                status: {
                  shapeId: "shape_result_status_nullable",
                },
              },
              required: ["data", "error", "headers", "status"],
              additionalProperties: false,
            },
            synthetic: true,
            provenance: [],
          },
          shape_result_data_nullable: {
            id: "shape_result_data_nullable",
            kind: "shape",
            resourceId: "res_1",
            node: {
              type: "nullable",
              itemShapeId: "shape_result_data",
            },
            synthetic: true,
            provenance: [],
          },
          shape_result_data: {
            id: "shape_result_data",
            kind: "shape",
            resourceId: "res_1",
            node: {
              type: "scalar",
              scalar: "string",
            },
            synthetic: false,
            provenance: [],
          },
          shape_result_error_nullable: {
            id: "shape_result_error_nullable",
            kind: "shape",
            resourceId: "res_1",
            node: {
              type: "nullable",
              itemShapeId: "shape_result_error",
            },
            synthetic: true,
            provenance: [],
          },
          shape_result_error: {
            id: "shape_result_error",
            kind: "shape",
            resourceId: "res_1",
            node: {
              type: "unknown",
            },
            synthetic: false,
            provenance: [],
          },
          shape_result_headers: {
            id: "shape_result_headers",
            kind: "shape",
            resourceId: "res_1",
            node: {
              type: "object",
              fields: {},
              additionalProperties: "shape_result_header_value",
            },
            synthetic: true,
            provenance: [],
          },
          shape_result_header_value: {
            id: "shape_result_header_value",
            kind: "shape",
            resourceId: "res_1",
            node: {
              type: "scalar",
              scalar: "string",
            },
            synthetic: true,
            provenance: [],
          },
          shape_result_status_nullable: {
            id: "shape_result_status_nullable",
            kind: "shape",
            resourceId: "res_1",
            node: {
              type: "nullable",
              itemShapeId: "shape_result_status",
            },
            synthetic: true,
            provenance: [],
          },
          shape_result_status: {
            id: "shape_result_status",
            kind: "shape",
            resourceId: "res_1",
            node: {
              type: "scalar",
              scalar: "integer",
            },
            synthetic: true,
            provenance: [],
          },
        },
      },
      typeProjector: {} as LoadedSourceCatalogTool["typeProjector"],
    } as LoadedSourceCatalogTool);

      expect(detail.summary.path).toBe("linear.administrableTeams");
      expect(detail.summary.method).toBe("query");

      expect(detail.contract.callSignature).toContain("Promise<");
      expect(detail.contract.callDeclaration).toContain("/**");
      expect(detail.contract.callDeclaration).toContain("Administrable Teams");
      expect(detail.contract.callDeclaration).toContain("declare function linearAdministrableTeams");
      expect(detail.contract.callShapeId).toBe("shape_call");
      expect(detail.contract.resultShapeId).toBe("shape_result");
      expect(detail.contract.input.typeDeclaration).toContain("type LinearAdministrableTeamsCall");
      expect(detail.contract.output.typeDeclaration).toContain("type LinearAdministrableTeamsResult");
      expect(detail.contract.input.typeDeclaration).toContain("The exact input string to filter by.");
      expect(detail.contract.output.typeDeclaration).toContain("Matching team data when present.");
      expect(detail.contract.input.schemaJson).toContain("\"input\"");
      expect(detail.contract.output.schemaJson).toContain("\"data\"");

      const sectionTitles = detail.sections.map((section) => section.title);
      expect(sectionTitles).not.toContain("Input Schema");
      expect(sectionTitles).not.toContain("Output Schema");

      const overview = detail.sections.find((section) => section.kind === "facts");
      expect(overview).toBeDefined();
      expect(overview?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "Signature" }),
          expect.objectContaining({ label: "Call shape", value: "shape_call" }),
          expect.objectContaining({ label: "Result shape", value: "shape_result" }),
        ]),
      );
    }));
});
