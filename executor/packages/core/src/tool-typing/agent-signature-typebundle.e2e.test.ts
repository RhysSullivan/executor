import { describe, expect, test } from "bun:test";
import { OPENAPI_HELPER_TYPES } from "../openapi/helper-types";
import { jsonSchemaTypeHintFallback } from "../openapi/schema-hints";
import { prepareOpenApiSpec, buildOpenApiToolsFromPrepared } from "../tool-sources";
import { connectMcp } from "../mcp-runtime";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

type ToolApproval = "auto" | "required";

type AgentToolSignature = {
  path: string;
  description: string;
  approval: ToolApproval;
  sourceKey: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  typedRef?: {
    kind: "openapi_operation";
    namespace: string;
    operationId: string;
  };
};

function requireTypeScript(): typeof import("typescript") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("typescript") as typeof import("typescript");
}

function safeNamespaceSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
  return cleaned.length > 0 ? cleaned : "source";
}

function indentBlock(value: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => (line.trim().length === 0 ? line : pad + line))
    .join("\n");
}

function wrapDtsInNamespace(namespace: string, rawDts: string): string {
  const stripped = rawDts.replace(/^export /gm, "").trim();
  return `declare namespace ${namespace} {\n${indentBlock(stripped, 2)}\n}`;
}

type NamespaceNode = {
  children: Map<string, NamespaceNode>;
  tools: AgentToolSignature[];
};

function buildTree(signatures: AgentToolSignature[]): NamespaceNode {
  const root: NamespaceNode = { children: new Map(), tools: [] };
  for (const sig of signatures) {
    const parts = sig.path.split(".");
    if (parts.length <= 1) {
      root.tools.push(sig);
      continue;
    }

    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      if (!node.children.has(part)) {
        node.children.set(part, { children: new Map(), tools: [] });
      }
      node = node.children.get(part)!;
    }
    node.tools.push(sig);
  }
  return root;
}

const memberNameRegex = /^[$A-Z_][0-9A-Z_$]*$/i;
function emitMemberName(name: string): string {
  return memberNameRegex.test(name) ? name : JSON.stringify(name);
}

function countAllTools(node: NamespaceNode): number {
  let count = node.tools.length;
  for (const child of node.children.values()) {
    count += countAllTools(child);
  }
  return count;
}

function tsTypeFromSchema(schema: Record<string, unknown> | undefined, fallback: string): string {
  if (!schema || Object.keys(schema).length === 0) return fallback;
  return jsonSchemaTypeHintFallback(schema);
}

function emitToolMethod(sig: AgentToolSignature): string {
  const methodName = emitMemberName(sig.path.split(".").at(-1) ?? "tool");
  const approvalNote = sig.approval === "required" ? " **Requires approval**" : "";
  const desc = (sig.description || "Call this tool.") + approvalNote;

  let inputType = "Record<string, unknown>";
  let outputType = "unknown";

  if (sig.typedRef?.kind === "openapi_operation") {
    const opKey = JSON.stringify(sig.typedRef.operationId);
    inputType = `ToolInput<${sig.typedRef.namespace}.operations[${opKey}]>`;
    outputType = `ToolOutput<${sig.typedRef.namespace}.operations[${opKey}]>`;
  } else {
    inputType = tsTypeFromSchema(sig.inputSchema, "Record<string, unknown>");
    outputType = tsTypeFromSchema(sig.outputSchema, "unknown");
  }

  const isOptionalInput = inputType === "{}";
  const inputParam = isOptionalInput ? `input?: ${inputType}` : `input: ${inputType}`;

  return `  /**\n   * ${desc}\n   * @source ${sig.sourceKey}\n   */\n  ${methodName}(${inputParam}): Promise<${outputType}>;`;
}

function emitNamespaceInterface(name: string, node: NamespaceNode, out: string[]): void {
  for (const [childName, childNode] of node.children) {
    emitNamespaceInterface(`${name}_${childName}`, childNode, out);
  }

  const members: string[] = [];
  for (const [childName, childNode] of node.children) {
    const toolCount = childNode.tools.length + countAllTools(childNode);
    members.push(
      `  /** ${toolCount} tool${toolCount !== 1 ? "s" : ""} in the \`${childName}\` namespace */\n  readonly ${emitMemberName(childName)}: ToolNS_${name}_${childName};`,
    );
  }
  for (const tool of node.tools) {
    members.push(emitToolMethod(tool));
  }

  out.push(`interface ToolNS_${name} {\n${members.join("\n\n")}\n}`);
}

function emitToolsProxyDts(signatures: AgentToolSignature[]): string {
  const root = buildTree(signatures);

  const interfaces: string[] = [];
  for (const [name, node] of root.children) {
    emitNamespaceInterface(name, node, interfaces);
  }

  const rootMembers: string[] = [];
  for (const [name] of root.children) {
    rootMembers.push(`  readonly ${emitMemberName(name)}: ToolNS_${name};`);
  }
  for (const tool of root.tools) {
    rootMembers.push(emitToolMethod(tool));
  }

  return [
    interfaces.join("\n\n"),
    "",
    "interface ToolsProxy {",
    rootMembers.join("\n\n"),
    "}",
    "",
    "declare const tools: ToolsProxy;",
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

async function fetchGraphqlSchema(endpoint: string): Promise<Record<string, unknown>> {
  const INTROSPECTION_QUERY = `
    query IntrospectionQuery {
      __schema {
        queryType { name }
        mutationType { name }
        types {
          kind name
          fields {
            name description
            args { name description type { ...TypeRef } defaultValue }
            type { ...TypeRef }
          }
          inputFields {
            name description
            type { ...TypeRef }
            defaultValue
          }
          enumValues { name description }
        }
      }
    }
    fragment TypeRef on __Type {
      kind name
      ofType {
        kind name
        ofType {
          kind name
          ofType {
            kind name
            ofType { kind name }
          }
        }
      }
    }
  `;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GraphQL introspection failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = (await resp.json()) as { data?: { __schema?: unknown }; errors?: unknown };
  if (json.errors) {
    throw new Error(`GraphQL introspection errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
  }
  const schema = json.data?.__schema;
  if (!schema || typeof schema !== "object") {
    throw new Error("GraphQL introspection returned no schema");
  }
  return schema as Record<string, unknown>;
}

function gqlUnwrapNamedType(ref: any): string | null {
  if (!ref || typeof ref !== "object") return null;
  if (ref.kind === "NON_NULL" && ref.ofType) return gqlUnwrapNamedType(ref.ofType);
  if (ref.kind === "LIST" && ref.ofType) return gqlUnwrapNamedType(ref.ofType);
  return typeof ref.name === "string" ? ref.name : null;
}

function gqlIsNonNull(ref: any): boolean {
  return Boolean(ref && typeof ref === "object" && ref.kind === "NON_NULL");
}

function gqlScalarToJsonSchemaType(name: string): Record<string, unknown> {
  switch (name) {
    case "String":
    case "ID":
    case "DateTime":
    case "Date":
    case "UUID":
      return { type: "string" };
    case "Int":
    case "Float":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    default:
      return {};
  }
}

function buildGraphqlArgsSchema(fieldArgs: any[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of fieldArgs) {
    const name = typeof arg?.name === "string" ? arg.name : "";
    if (!name) continue;
    const typeRef = arg.type;
    const named = gqlUnwrapNamedType(typeRef);
    properties[name] = named ? gqlScalarToJsonSchemaType(named) : {};
    if (gqlIsNonNull(typeRef)) {
      required.push(name);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

async function startLocalMcpServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = new McpServer(
        { name: "mcp-typing-fixture", version: "0.0.1" },
        { capabilities: { tools: {} } },
      );

      mcp.registerTool(
        "create_issue",
        {
          description: "Create an issue in a repository (fixture).",
          // MCP SDK typing expects a Zod-ish schema type; runtime accepts JSON Schema.
          inputSchema: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              title: { type: "string" },
              body: { type: "string" },
              labels: { type: "array", items: { type: "string" } },
              state: { type: "string", enum: ["open", "closed"] },
            },
            required: ["owner", "repo", "title"],
          } as unknown as any,
        },
        async () => {
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      );

      try {
        await mcp.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        await transport.close().catch(() => {});
        await mcp.close().catch(() => {});
      }
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    stop: async () => {
      server.stop(true);
    },
  };
}

describe("agent signature -> monaco typebundle (exploration)", () => {
  test(
    "real OpenAPI + real GraphQL + real MCP server can produce a parseable .d.ts bundle",
    async () => {
      // --- OpenAPI (real) ---
      const openApiFixtures = [
        {
          name: "vercel",
          spec: "https://openapi.vercel.sh",
          defaultBaseUrl: "https://api.vercel.com",
        },
        {
          // Small, stable spec used by many OpenAPI toolchains.
          name: "petstore",
          spec: "https://petstore3.swagger.io/api/v3/openapi.json",
          defaultBaseUrl: "https://petstore3.swagger.io",
        },
      ] as const;

      const preparedSpecs = await Promise.all(
        openApiFixtures.map(async (fixture) => {
          const prepared = await prepareOpenApiSpec(fixture.spec, fixture.name);
          expect(prepared.dts).toBeDefined();
          expect(prepared.dts!.length).toBeGreaterThan(0);

          const tools = buildOpenApiToolsFromPrepared(
            {
              type: "openapi",
              name: fixture.name,
              spec: fixture.spec,
              baseUrl: prepared.servers[0] ?? fixture.defaultBaseUrl,
            },
            prepared,
          );

          const tool = tools.find((t) => t.typing?.typedRef?.kind === "openapi_operation")!;
          expect(tool).toBeDefined();
          return { fixture, prepared, tools, tool };
        }),
      );

      const openApiSignatures: AgentToolSignature[] = preparedSpecs.map(({ fixture, prepared: _prepared, tool }) => {
        const sourceKey = `openapi:${fixture.name}`;
        const namespace = `OpenApi_${safeNamespaceSegment(sourceKey)}`;
        const sig: AgentToolSignature = {
          path: tool.path,
          description: tool.description,
          approval: "auto",
          sourceKey,
          typedRef: {
            kind: "openapi_operation",
            namespace,
            operationId: tool.typing!.typedRef!.operationId,
          },
        };
        expect(sig.typedRef).toBeDefined();
        expect(sig.typedRef!.namespace).toBe(namespace);
        return sig;
      });

      // --- GraphQL (real) ---
      const countriesEndpoint = "https://countries.trevorblades.com/";
      const gqlSchema = await fetchGraphqlSchema(countriesEndpoint);
      const types = Array.isArray(gqlSchema.types) ? gqlSchema.types : [];
      const queryTypeName = (gqlSchema.queryType as any)?.name as string | undefined;
      expect(typeof queryTypeName).toBe("string");

      const queryType = types.find((t: any) => t && t.name === queryTypeName);
      const fields = Array.isArray((queryType as any)?.fields) ? (queryType as any).fields : [];
      const countryField = fields.find((f: any) => f && f.name === "country");
      expect(countryField).toBeDefined();

      const gqlArgsSchema = buildGraphqlArgsSchema(countryField.args);
      const gqlSignature: AgentToolSignature = {
        path: "countries.query.country",
        description: "GraphQL query helper (fixture from real schema).",
        approval: "auto",
        sourceKey: "graphql:countries",
        inputSchema: gqlArgsSchema,
        outputSchema: {
          type: "object",
          properties: {
            data: {},
            errors: { type: "array", items: {} },
          },
          required: ["data"],
        },
      };

      // --- MCP (real server instance) ---
      const mcp = await startLocalMcpServer();
      let mcpTool: any;
      try {
        const conn = await connectMcp(`${mcp.url}/mcp`, undefined, "streamable-http");
        try {
          const listed = await conn.client.listTools();
          const tools = Array.isArray((listed as any).tools) ? (listed as any).tools : [];
          mcpTool = tools.find((t: any) => t && t.name === "create_issue");
          expect(mcpTool).toBeDefined();
        } finally {
          await conn.close();
        }
      } finally {
        await mcp.stop();
      }

      const mcpSignature: AgentToolSignature = {
        path: "mcp_fixture.create_issue",
        description: String(mcpTool.description ?? "MCP create_issue"),
        approval: "required",
        sourceKey: "mcp:fixture",
        inputSchema: (mcpTool.inputSchema ?? {}) as Record<string, unknown>,
        outputSchema: {},
      };

      // --- Emit bundle ---
      const toolsDts = emitToolsProxyDts([...openApiSignatures, gqlSignature, mcpSignature]);
      for (const sig of openApiSignatures) {
        expect(toolsDts).toContain(`@source ${sig.sourceKey}`);
      }

      const openApiDtsBlocks = preparedSpecs.map(({ fixture, prepared }) => {
        const sourceKey = `openapi:${fixture.name}`;
        const namespace = `OpenApi_${safeNamespaceSegment(sourceKey)}`;
        return wrapDtsInNamespace(namespace, prepared.dts!);
      });
      const bundle = [
        "// Generated for exploration test only",
        OPENAPI_HELPER_TYPES.trim(),
        ...openApiDtsBlocks,
        toolsDts,
      ].join("\n\n");

      // Parse with TypeScript to ensure the .d.ts is syntactically valid.
      const ts = requireTypeScript();

      const fileName = "bundle.d.ts";
      const host: import("typescript").CompilerHost = {
        getSourceFile: (name, languageVersion) => {
          if (name === fileName) {
            return ts.createSourceFile(name, bundle, languageVersion, true, ts.ScriptKind.TS);
          }
          return undefined as any;
        },
        writeFile: () => {},
        getDefaultLibFileName: () => "lib.d.ts",
        useCaseSensitiveFileNames: () => true,
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => ".",
        getNewLine: () => "\n",
        fileExists: (name) => name === fileName,
        readFile: (name) => (name === fileName ? bundle : undefined),
        directoryExists: () => true,
        getDirectories: () => [],
      };

      const program = ts.createProgram({
        rootNames: [fileName],
        options: { noLib: true, skipLibCheck: true, noEmit: true },
        host,
      });

      const syntactic = program.getSyntacticDiagnostics();
      expect(syntactic.length).toBe(0);

      const sf = program.getSourceFile(fileName);
      expect(sf).toBeDefined();

      // Ensure we didn't leak top-level `interface operations` (it should be namespaced).
      const topLevelOperations = (sf!.statements ?? []).filter(
        (stmt) => ts.isInterfaceDeclaration(stmt) && stmt.name.text === "operations",
      );
      expect(topLevelOperations.length).toBe(0);

      // Spot-check OpenAPI types are namespaced (avoids `operations` collisions).
      for (const sig of openApiSignatures) {
        const ns = sig.typedRef!.namespace;
        expect(bundle).toContain(`declare namespace ${ns}`);
        expect(bundle).toContain(`@source ${sig.sourceKey}`);
      }
      // Ensure both OpenAPI namespaces made it into the ToolsProxy.
      expect(bundle).toContain("readonly vercel: ToolNS_vercel;");
      expect(bundle).toContain("readonly petstore: ToolNS_petstore;");
      // Ensure the tool methods reference the namespaced OpenAPI operations map.
      expect(bundle).toMatch(/OpenApi_[A-Za-z0-9_]+\.operations\[/);
      expect(bundle).toMatch(/ToolInput<OpenApi_[A-Za-z0-9_]+\.operations\[/);
      expect(bundle).toMatch(/ToolOutput<OpenApi_[A-Za-z0-9_]+\.operations\[/);
      expect(bundle).toContain("declare const tools");
      // Spot-check JSON-schema-derived MCP signature made it into the bundle.
      expect(bundle).toContain("owner: string");
      // Spot-check JSON-schema-derived GraphQL args schema made it into the bundle.
      expect(bundle).toContain("code: string");
    },
    300_000,
  );

  test("JSON schema fallback produces useful MCP-ish arg hints", () => {
    const schema = {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        state: { type: "string", enum: ["open", "closed"] },
      },
      required: ["owner", "repo"],
    } satisfies Record<string, unknown>;

    const hint = jsonSchemaTypeHintFallback(schema);
    expect(hint).toContain("owner");
    expect(hint).toContain("repo");
    expect(hint).toContain("labels");
    expect(hint).toContain("string[]");
    expect(hint).toContain("\"open\"");
  });
});
