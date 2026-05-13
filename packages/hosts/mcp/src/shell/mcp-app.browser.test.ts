import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { createExecutor, makeTestConfig } from "@executor-js/sdk";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { dynamicUiPlugin } from "@executor-js/plugin-dynamic-ui";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import { createServer as createViteServer } from "vite";

import { createExecutorMcpServer } from "../server";

type ShellServer = {
  readonly url: string;
  readonly close: () => Promise<void>;
};

type HostServer = ShellServer;

type OpenApiServer = {
  readonly specUrl: string;
  readonly postRequests: readonly string[];
  readonly close: () => Promise<void>;
};

type McpHarness = {
  readonly callTool: (params: HostToolCall) => Promise<unknown>;
  readonly close: () => Promise<void>;
};

type HostToolCall = {
  readonly name?: string;
  readonly arguments?: Record<string, unknown>;
};

type HostState = {
  readonly initialized: boolean;
  readonly toolCalls: HostToolCall[];
  readonly resumeCalls: HostToolCall[];
};

type BrowserHostWindow = Window & {
  __mcpHostState: HostState;
  __sendGeneratedUi: (code: string) => void;
};

type AppsClientCapabilities = ClientCapabilities & {
  readonly extensions: Record<string, unknown>;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const chromeExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/google-chrome";
const testScope = "test-scope";

const appsWithoutElicitationCapabilities: AppsClientCapabilities = {
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
};

const networkPrimitives = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
] as const;

const generatedDataCode = `
const primitiveNames = ${JSON.stringify(networkPrimitives)};
const blockedMessages = primitiveNames.map((name) => {
  try {
    globalThis[name]("https://example.com/should-not-load");
    return name + ":allowed";
  } catch (err) {
    return name + ":" + (err instanceof Error ? err.message : String(err));
  }
});

function App() {
  const { data, error, isLoading } = useQuery(() => tools.inventory.items.listItems({}));
  return (
    <Card>
      <CardContent>
        <div id="status">{isLoading ? "loading" : error ? error.message : data?.[0]?.name}</div>
        <pre id="blocked">{blockedMessages.join("\\n")}</pre>
      </CardContent>
    </Card>
  );
}
`;

const generatedStaticCode = `
function App() {
  return (
    <Card>
      <CardContent>
        <div id="ready">ready</div>
      </CardContent>
    </Card>
  );
}
`;

const generatedApprovalCode = `
function App() {
  const [status, setStatus] = useState("idle");
  const createItem = useMutation((input) => tools.inventory.items.createItem(input), {
    onSuccess: (result) => setStatus(result.name + ":" + result.created),
    onError: (error) => setStatus(error.message),
  });
  const ask = async () => {
    setStatus("pending");
    await createItem.mutate({ body: { name: "Approved Widget" } });
  };

  return (
    <Card>
      <CardContent>
        <Button id="ask" onClick={ask}>Ask</Button>
        <div id="mutation-pending">{String(createItem.isPending)}</div>
        <div id="approval-status">{status}</div>
      </CardContent>
    </Card>
  );
}
`;

const createHostHtml = (shellUrl: string) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>MCP Apps Browser Harness</title>
  </head>
  <body>
    <iframe
      id="app"
      src="${shellUrl}/mcp-app.html"
      style="width: 1000px; height: 900px; border: 0"
    ></iframe>
    <script>
      const appFrame = document.getElementById("app");
      const state = {
        initialized: false,
        toolCalls: [],
        resumeCalls: [],
      };
      window.__mcpHostState = state;

      const sendToApp = (message) => {
        appFrame.contentWindow.postMessage(message, "*");
      };

      const respond = (source, id, result) => {
        source.postMessage({ jsonrpc: "2.0", id, result }, "*");
      };

      window.__sendGeneratedUi = (code) => {
        sendToApp({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [{ type: "text", text: "" }],
            structuredContent: { code },
          },
        });
      };

      window.addEventListener("message", (event) => {
        if (event.source !== appFrame.contentWindow) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;

        if (message.method === "ui/initialize" && message.id !== undefined) {
          respond(event.source, message.id, {
            protocolVersion: message.params?.protocolVersion ?? "2026-01-26",
            hostInfo: { name: "Browser Harness", version: "1.0.0" },
            hostCapabilities: {
              openLinks: {},
              serverTools: { listChanged: true },
            },
            hostContext: {
              theme: "light",
              displayMode: "inline",
              platform: "web",
            },
          });
          return;
        }

        if (message.method === "ui/notifications/initialized") {
          state.initialized = true;
          return;
        }

        if (message.method === "tools/call" && message.id !== undefined) {
          const params = message.params ?? {};
          state.toolCalls.push(params);

          if (params.name === "execute-action-resume") {
            state.resumeCalls.push(params);
          }

          fetch("/tools/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(params),
          })
            .then((response) => response.json())
            .then((result) => respond(event.source, message.id, result))
            .catch((err) =>
              event.source.postMessage(
                {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
                },
                "*",
              ),
            );
        }
      });
    </script>
  </body>
</html>`;

const startShellServer = async (): Promise<ShellServer> => {
  const server = await createViteServer({
    configFile: resolve(packageRoot, "vite.config.shell.ts"),
    clearScreen: false,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
    },
  });

  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    throw new Error("Vite did not report a local shell URL.");
  }

  return {
    url: url.replace(/\/$/, ""),
    close: () => server.close(),
  };
};

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });

const startOpenApiServer = (): Promise<OpenApiServer> =>
  new Promise((resolveServer, rejectServer) => {
    let baseUrl = "";
    const postRequests: string[] = [];

    const server: Server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/openapi.json") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            openapi: "3.0.0",
            info: { title: "Inventory", version: "1.0.0" },
            servers: [{ url: baseUrl }],
            paths: {
              "/items": {
                get: {
                  operationId: "listItems",
                  responses: {
                    "200": {
                      description: "Inventory items",
                      content: {
                        "application/json": {
                          schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/Item" },
                          },
                        },
                      },
                    },
                  },
                },
                post: {
                  operationId: "createItem",
                  requestBody: {
                    required: true,
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/CreateItem" },
                      },
                    },
                  },
                  responses: {
                    "200": {
                      description: "Created item",
                      content: {
                        "application/json": {
                          schema: { $ref: "#/components/schemas/CreatedItem" },
                        },
                      },
                    },
                  },
                },
              },
            },
            components: {
              schemas: {
                Item: {
                  type: "object",
                  required: ["id", "name"],
                  properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                  },
                },
                CreateItem: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                  },
                },
                CreatedItem: {
                  type: "object",
                  required: ["id", "name", "created"],
                  properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                    created: { type: "boolean" },
                  },
                },
              },
            },
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/items") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify([{ id: 1, name: "Seed Widget" }]));
        return;
      }

      if (request.method === "POST" && request.url === "/items") {
        const body = await readBody(request);
        postRequests.push(body);
        const parsed = JSON.parse(body) as { name?: unknown };
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: 2,
            name: typeof parsed.name === "string" ? parsed.name : "Unnamed",
            created: true,
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    });

    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectServer);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("Failed to resolve OpenAPI server address."));
        return;
      }

      const { port } = address as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolveServer({
        specUrl: `${baseUrl}/openapi.json`,
        postRequests,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });

const startMcpHarness = async (openApi: OpenApiServer): Promise<McpHarness> => {
  const executor = await Effect.runPromise(
    createExecutor(makeTestConfig({ plugins: [openApiPlugin()] as const })),
  );

  await Effect.runPromise(
    executor.openapi.addSpec({
      scope: testScope,
      spec: openApi.specUrl,
      namespace: "inventory",
    }),
  );

  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeQuickJsExecutor({
      timeoutMs: 5_000,
      memoryLimitBytes: 32 * 1024 * 1024,
    }),
  });
  const mcpServer = await Effect.runPromise(
    createExecutorMcpServer({ engine, plugins: [dynamicUiPlugin()] }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "browser-harness", version: "1.0.0" },
    { capabilities: appsWithoutElicitationCapabilities },
  );

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    callTool: async (params) => {
      if (!params.name) {
        throw new Error("Missing MCP tool name.");
      }
      return client.callTool({
        name: params.name,
        arguments: params.arguments ?? {},
      });
    },
    close: async () => {
      await clientTransport.close();
      await serverTransport.close();
    },
  };
};

const startHostServer = (shellUrl: string, mcp: McpHarness): Promise<HostServer> =>
  new Promise((resolveServer, rejectServer) => {
    const html = createHostHtml(shellUrl);
    const server: Server = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/tools/call") {
        try {
          const body = await readBody(request);
          const params = JSON.parse(body) as HostToolCall;
          const result = await mcp.callTool(params);
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(result));
        } catch (err) {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              content: [
                {
                  type: "text",
                  text: err instanceof Error ? err.message : String(err),
                },
              ],
              isError: true,
            }),
          );
        }
        return;
      }

      if (request.method !== "GET" || request.url !== "/") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }

      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html);
    });

    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectServer);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("Failed to resolve host server address."));
        return;
      }

      const { port } = address as AddressInfo;
      resolveServer({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });

const waitForValue = async <T>(
  page: Page,
  read: () => T | undefined,
  label: string,
): Promise<T> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const waitForShellFrame = (page: Page): Promise<Frame> =>
  waitForValue(
    page,
    () => page.frames().find((frame) => frame.url().includes("/mcp-app.html")),
    "MCP app shell iframe",
  );

const waitForInnerFrame = async (page: Page, shellFrame: Frame): Promise<Frame> => {
  const locator = shellFrame.locator('iframe[title="Generated UI"]');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const handle = await locator.elementHandle();
    const frame = await handle?.contentFrame();
    await handle?.dispose();
    if (frame) return frame;
    await page.waitForTimeout(50);
  }
  throw new Error("Timed out waiting for generated UI iframe.");
};

const waitForHostInitialized = (page: Page) =>
  page.waitForFunction(() =>
    Boolean((window as unknown as BrowserHostWindow).__mcpHostState.initialized),
  );

const getHostState = (page: Page): Promise<HostState> =>
  page.evaluate(() => (window as unknown as BrowserHostWindow).__mcpHostState);

const openHarness = async (browser: Browser, hostUrl: string) => {
  const page = await browser.newPage();
  await page.goto(hostUrl, { waitUntil: "domcontentloaded" });
  const shellFrame = await waitForShellFrame(page);
  await waitForHostInitialized(page);
  await shellFrame.locator("text=Waiting for UI").waitFor({ timeout: 10_000 });
  return { page, shellFrame };
};

const renderGeneratedUi = async (page: Page, shellFrame: Frame, code: string): Promise<Frame> => {
  await page.evaluate(
    (value) => (window as unknown as BrowserHostWindow).__sendGeneratedUi(value),
    code,
  );
  await shellFrame.locator('iframe[title="Generated UI"]').waitFor({ timeout: 10_000 });
  return waitForInnerFrame(page, shellFrame);
};

describe("MCP app generated UI browser isolation", () => {
  let openApiServer: OpenApiServer | undefined;
  let mcpHarness: McpHarness | undefined;
  let shellServer: ShellServer | undefined;
  let hostServer: HostServer | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    openApiServer = await startOpenApiServer();
    mcpHarness = await startMcpHarness(openApiServer);
    shellServer = await startShellServer();
    hostServer = await startHostServer(shellServer.url, mcpHarness);
    browser = await chromium.launch({
      executablePath: chromeExecutablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await hostServer?.close();
    await shellServer?.close();
    await mcpHarness?.close();
    await openApiServer?.close();
  }, 30_000);

  it("runs generated UI in a sandboxed browser iframe and proxies live tool calls", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedDataCode);
      await innerFrame.waitForFunction(
        () => document.querySelector("#status")?.textContent === "Seed Widget",
        undefined,
        { timeout: 10_000 },
      );

      const rendererAttributes = await shellFrame
        .locator('iframe[title="Generated UI"]')
        .evaluate((element) => ({
          sandbox: element.getAttribute("sandbox"),
          srcDoc: element.getAttribute("srcdoc") ?? "",
        }));

      expect(rendererAttributes.sandbox).toBe("allow-scripts");
      expect(rendererAttributes.srcDoc).toContain('meta name="executor-render-token"');
      expect(rendererAttributes.srcDoc).toContain("default-src 'none'");
      expect(rendererAttributes.srcDoc).toContain("connect-src 'none'");
      expect(rendererAttributes.srcDoc).toContain("form-action 'none'");
      expect(rendererAttributes.srcDoc).toContain("frame-src 'none'");
      expect(rendererAttributes.srcDoc).toContain("worker-src 'none'");

      const parentAccess = await innerFrame.evaluate(() => {
        try {
          void window.parent.document.body;
          return "allowed";
        } catch (err) {
          return err instanceof DOMException ? err.name : String(err);
        }
      });
      expect(parentAccess).toBe("SecurityError");

      const blockedText = (await innerFrame.locator("#blocked").textContent()) ?? "";
      for (const name of networkPrimitives) {
        expect(blockedText).toContain(
          `${name} is disabled in generated UI. Use tools.* via useQuery/useMutation.`,
        );
      }

      const hostState = await getHostState(page);
      expect(hostState.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "execute-action",
            arguments: {
              code: "return await tools.inventory.items.listItems({})",
            },
          }),
        ]),
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  it("rejects spoofed renderer messages unless the iframe window and token match", async () => {
    if (!browser || !hostServer) throw new Error("Browser harness did not start.");
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedStaticCode);
      await innerFrame.locator("#ready").waitFor({ timeout: 10_000 });

      await shellFrame.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Generated UI"]');
        const srcDoc = iframe?.getAttribute("srcdoc") ?? "";
        const token = /<meta name="executor-render-token" content="([^"]+)">/.exec(srcDoc)?.[1];
        if (!iframe?.contentWindow || !token) {
          throw new Error("Generated UI iframe is missing a token.");
        }

        window.dispatchEvent(
          new MessageEvent("message", {
            source: window,
            data: { type: "executor.run", requestId: 1, token, code: "return 42" },
          }),
        );
        window.dispatchEvent(
          new MessageEvent("message", {
            source: iframe.contentWindow,
            data: { type: "executor.run", requestId: 2, token: "wrong", code: "return 42" },
          }),
        );
      });

      await page.waitForTimeout(100);
      expect((await getHostState(page)).toolCalls).toHaveLength(0);

      await shellFrame.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Generated UI"]');
        const srcDoc = iframe?.getAttribute("srcdoc") ?? "";
        const token = /<meta name="executor-render-token" content="([^"]+)">/.exec(srcDoc)?.[1];
        if (!iframe?.contentWindow || !token) {
          throw new Error("Generated UI iframe is missing a token.");
        }

        window.dispatchEvent(
          new MessageEvent("message", {
            source: iframe.contentWindow,
            data: { type: "executor.run", requestId: 3, token, code: "return 42" },
          }),
        );
      });

      await page.waitForFunction(
        () => (window as unknown as BrowserHostWindow).__mcpHostState.toolCalls.length === 1,
      );
      expect((await getHostState(page)).toolCalls[0]).toEqual(
        expect.objectContaining({
          name: "execute-action",
          arguments: { code: "return 42" },
        }),
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  it("handles elicitations in the trusted shell instead of the generated iframe", async () => {
    if (!browser || !hostServer || !openApiServer) {
      throw new Error("Browser harness did not start.");
    }
    const { page, shellFrame } = await openHarness(browser, hostServer.url);

    try {
      const innerFrame = await renderGeneratedUi(page, shellFrame, generatedApprovalCode);
      await innerFrame.locator("#ask").waitFor({ timeout: 10_000 });
      await innerFrame.locator("#ask").click({ timeout: 10_000 });

      await shellFrame.locator("text=Approve action").waitFor({ timeout: 10_000 });
      expect(await innerFrame.locator("text=Approve action").count()).toBe(0);
      expect(openApiServer.postRequests).toHaveLength(0);

      await shellFrame.getByRole("button", { name: "Approve" }).click({ timeout: 10_000 });
      await innerFrame.waitForFunction(
        () => document.querySelector("#approval-status")?.textContent === "Approved Widget:true",
        undefined,
        { timeout: 10_000 },
      );
      expect(openApiServer.postRequests).toEqual([JSON.stringify({ name: "Approved Widget" })]);

      const hostState = await getHostState(page);
      expect(hostState.resumeCalls).toEqual([
        expect.objectContaining({
          name: "execute-action-resume",
          arguments: {
            executionId: expect.any(String),
            action: "accept",
            content: "{}",
          },
        }),
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
