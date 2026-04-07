// Pre-load QuickJS WASM for compiled binaries — must run before server imports
import { dirname, join } from "node:path";
const wasmOnDisk = join(dirname(process.execPath), "emscripten-module.wasm");
if (typeof Bun !== "undefined" && await Bun.file(wasmOnDisk).exists()) {
  const { setQuickJSModule } = await import("@executor/runtime-quickjs");
  const { newQuickJSWASMModule } = await import("quickjs-emscripten");
  const wasmBinary = await Bun.file(wasmOnDisk).arrayBuffer();
  const variant = {
    type: "sync" as const,
    importFFI: () => import("@jitl/quickjs-wasmfile-release-sync/ffi").then((m: any) => m.QuickJSFFI),
    importModuleLoader: () =>
      import("@jitl/quickjs-wasmfile-release-sync/emscripten-module").then((m: any) => {
        const original = m.default;
        return (moduleArg: any = {}) => original({ ...moduleArg, wasmBinary });
      }),
  };
  const mod = await newQuickJSWASMModule(variant as any);
  setQuickJSModule(mod);
}

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Command, Options, Args } from "@effect/cli";
import { BunRuntime } from "@effect/platform-bun";
import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";

import { ExecutorApi } from "@executor/api";
import { createServerHandlers, runMcpStdioServer, getExecutor } from "@executor/local";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_NAME = "executor";
const { version: CLI_VERSION } = await import("../package.json");
const DEFAULT_PORT = 4788;
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_PORT}`;

// Embedded web UI — baked into compiled binaries via `with { type: "file" }`
import embeddedWebUI from "./embedded-web-ui.gen";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const waitForShutdownSignal = () =>
  Effect.async<void, never>((resume) => {
    const shutdown = () => resume(Effect.void);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return Effect.sync(() => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    });
  });

const appendUrlPath = (baseUrl: string, pathname: string): string =>
  new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

const renderSessionSummary = (kind: "web" | "mcp", baseUrl: string): string => {
  const displayKind = kind === "mcp" ? "MCP" : "web";
  const primaryLabel = kind === "web" ? "Web" : "MCP";
  const primaryUrl = kind === "web" ? baseUrl : appendUrlPath(baseUrl, "mcp");
  const secondaryLabel = kind === "web" ? "MCP" : "Web";
  const secondaryUrl = kind === "web" ? appendUrlPath(baseUrl, "mcp") : baseUrl;
  const guidance =
    kind === "web"
      ? "Keep this process running while you use the browser session."
      : "Use this MCP URL in your client and keep this process running.";

  return [
    `Executor ${displayKind} session is ready.`,
    `${primaryLabel}: ${primaryUrl}`,
    `${secondaryLabel}: ${secondaryUrl}`,
    `OpenAPI: ${appendUrlPath(baseUrl, "docs")}`,
    "",
    guidance,
    "Press Ctrl+C to stop.",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Background server management
// ---------------------------------------------------------------------------

const isServerReachable = async (baseUrl: string): Promise<boolean> => {
  try {
    const res = await fetch(`${baseUrl}/docs`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
};

const script = process.argv[1];
const isDevMode = script?.endsWith(".ts") || script?.endsWith(".js");
const cliPrefix = isDevMode ? `bun run ${script}` : "executor";

const startBackgroundServer = (port: number): void => {
  const args = isDevMode
    ? ["run", script, "web", "--port", String(port)]
    : ["web", "--port", String(port)];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

const ensureServer = (baseUrl: string) =>
  Effect.gen(function* () {
    if (yield* Effect.promise(() => isServerReachable(baseUrl))) return;

    const url = new URL(baseUrl);
    const port = Number(url.port) || DEFAULT_PORT;
    console.error(`Starting background server on port ${port}...`);
    startBackgroundServer(port);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)));
      if (yield* Effect.promise(() => isServerReachable(baseUrl))) return;
    }

    return yield* Effect.fail(new Error(`Server failed to start within 30s at ${baseUrl}`));
  });

// ---------------------------------------------------------------------------
// Typed API client
// ---------------------------------------------------------------------------

const makeApiClient = (baseUrl: string) =>
  HttpApiClient.make(ExecutorApi, { baseUrl }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );

// ---------------------------------------------------------------------------
// Static file serving from embedded web UI
// ---------------------------------------------------------------------------

const WEB_DIST_DIR = resolve(import.meta.dirname, "../../local/dist");

const serveStatic = async (pathname: string): Promise<Response | null> => {
  const key = pathname.replace(/^\//, "");

  // Compiled binary: serve from embedded bunfs
  if (embeddedWebUI) {
    const match = embeddedWebUI[key] ?? embeddedWebUI["index.html"] ?? null;
    if (!match) return null;
    const file = Bun.file(match);
    return new Response(file, {
      headers: { "content-type": file.type || "application/octet-stream" },
    });
  }

  // Dev mode: serve from apps/local/dist on disk
  const filePath = resolve(WEB_DIST_DIR, key);
  if (!filePath.startsWith(WEB_DIST_DIR)) return null;

  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "content-type": file.type || "application/octet-stream" },
    });
  }

  // SPA fallback
  const index = Bun.file(resolve(WEB_DIST_DIR, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "content-type": "text/html" } });
  }

  return null;
};

// ---------------------------------------------------------------------------
// Host-header allowlist — blocks DNS rebinding attacks
// ---------------------------------------------------------------------------

const ALLOWED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

const isAllowedHost = (request: Request): boolean => {
  const host = request.headers.get("host");
  if (!host) return true; // no host header (e.g. HTTP/1.0) — allow
  // Strip port ("localhost:4788" → "localhost")
  const hostname = host.replace(/:\d+$/, "");
  return ALLOWED_HOSTS.has(hostname);
};

// ---------------------------------------------------------------------------
// Foreground session — API + MCP + Web UI on one Bun.serve()
// ---------------------------------------------------------------------------

const runForegroundSession = (input: { kind: "web" | "mcp"; port: number }) =>
  Effect.gen(function* () {
    const handlers = yield* Effect.promise(() => createServerHandlers());

    // Bind to loopback only — one server per address family so both
    // "localhost" (which may resolve to ::1 on Windows) and 127.0.0.1 work,
    // without exposing the server on the LAN.
    const fetch = async (request: Request): Promise<Response> => {
      if (!isAllowedHost(request)) {
        return new Response("Forbidden", { status: 403 });
      }

      const url = new URL(request.url);

      if (url.pathname.startsWith("/mcp")) {
        return handlers.mcp.handleRequest(request);
      }

      if (
        url.pathname.startsWith("/v1/") ||
        url.pathname.startsWith("/docs") ||
        url.pathname === "/openapi.json"
      ) {
        return handlers.api.handler(request);
      }

      const staticResponse = await serveStatic(url.pathname);
      if (staticResponse) return staticResponse;

      return new Response("Not Found", { status: 404 });
    };

    const serverV4 = Bun.serve({ port: input.port, hostname: "127.0.0.1", fetch });

    // IPv6 loopback — may fail on systems without IPv6; that's fine.
    let serverV6: ReturnType<typeof Bun.serve> | null = null;
    try {
      serverV6 = Bun.serve({ port: input.port, hostname: "::1", fetch });
    } catch {
      // IPv6 not available — continue with IPv4 only
    }

    const server = serverV4;

    const baseUrl = `http://localhost:${server.port}`;
    console.log(renderSessionSummary(input.kind, baseUrl));

    yield* waitForShutdownSignal();

    serverV4.stop(true);
    serverV6?.stop(true);
    yield* Effect.promise(() => handlers.mcp.close());
    yield* Effect.promise(() => handlers.api.dispose());
  });

// ---------------------------------------------------------------------------
// Stdio MCP session
// ---------------------------------------------------------------------------

const runStdioMcpSession = () =>
  Effect.gen(function* () {
    const executor = yield* Effect.promise(() => getExecutor());
    yield* Effect.promise(() => runMcpStdioServer({ executor }));
  });

// ---------------------------------------------------------------------------
// Code resolution — positional arg > --file > stdin
// ---------------------------------------------------------------------------

const readCode = (input: {
  code: Option.Option<string>;
  file: Option.Option<string>;
  stdin: boolean;
}): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const code = Option.getOrUndefined(input.code);
    if (code && code.trim().length > 0) return code;

    const file = Option.getOrUndefined(input.file);
    if (file && file.trim().length > 0) {
      const contents = yield* Effect.tryPromise({
        try: () => Bun.file(file).text(),
        catch: (e) => new Error(`Failed to read file: ${e}`),
      });
      if (contents.trim().length > 0) return contents;
    }

    if (input.stdin || !process.stdin.isTTY) {
      const chunks: string[] = [];
      process.stdin.setEncoding("utf8");
      const contents = yield* Effect.tryPromise({
        try: async () => {
          for await (const chunk of process.stdin) chunks.push(chunk as string);
          return chunks.join("");
        },
        catch: (e) => new Error(`Failed to read stdin: ${e}`),
      });
      if (contents.trim().length > 0) return contents;
    }

    return yield* Effect.fail(
      new Error("No code provided. Pass code as an argument, --file, or pipe to stdin."),
    );
  });

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const callCommand = Command.make(
  "call",
  {
    code: Args.text({ name: "code" }).pipe(Args.optional),
    file: Options.text("file").pipe(Options.optional),
    stdin: Options.boolean("stdin").pipe(Options.withDefault(false)),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
  },
  ({ code, file, stdin, baseUrl }) =>
    Effect.gen(function* () {
      const resolvedCode = yield* readCode({ code, file, stdin });
      yield* ensureServer(baseUrl);

      const client = yield* makeApiClient(baseUrl);
      const result = yield* client.executions.execute({ payload: { code: resolvedCode } });

      if (result.status === "completed") {
        if (result.isError) {
          console.error(result.text);
          process.exitCode = 1;
        } else {
          console.log(result.text);
        }
      } else {
        console.log(result.text);
        const executionId = (result.structured as any)?.executionId;
        if (executionId) {
          console.log(
            `\nTo resume:\n  ${cliPrefix} resume --execution-id ${executionId} --action accept`,
          );
        }
      }
    }),
).pipe(Command.withDescription("Execute code against the local executor"));

const resumeCommand = Command.make(
  "resume",
  {
    executionId: Options.text("execution-id"),
    action: Options.text("action").pipe(Options.withDefault("accept")),
    content: Options.text("content").pipe(Options.optional),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
  },
  ({ executionId, action, content, baseUrl }) =>
    Effect.gen(function* () {
      yield* ensureServer(baseUrl);

      const parsedContent = Option.getOrUndefined(content);
      const contentObj = parsedContent ? JSON.parse(parsedContent) : undefined;

      const client = yield* makeApiClient(baseUrl);
      const result = yield* client.executions.resume({
        path: { executionId },
        payload: { action: action as "accept" | "decline" | "cancel", content: contentObj },
      });

      if (result.isError) {
        console.error(result.text);
        process.exitCode = 1;
      } else {
        console.log(result.text);
      }
    }),
).pipe(Command.withDescription("Resume a paused execution"));

const scope = Options.text("scope").pipe(
  Options.optional,
  Options.withDescription("Path to workspace directory containing executor.jsonc"),
);

const applyScope = (s: Option.Option<string>) => {
  const dir = Option.getOrUndefined(s);
  if (dir) process.env.EXECUTOR_SCOPE_DIR = resolve(dir);
};

const webCommand = Command.make(
  "web",
  {
    port: Options.integer("port").pipe(Options.withDefault(DEFAULT_PORT)),
    scope,
  },
  ({ port, scope }) => Effect.gen(function* () {
    applyScope(scope);
    yield* runForegroundSession({ kind: "web", port });
  }),
).pipe(Command.withDescription("Start a foreground web session"));

const mcpCommand = Command.make(
  "mcp",
  { scope },
  ({ scope }) => Effect.gen(function* () {
    applyScope(scope);
    yield* runStdioMcpSession();
  }),
).pipe(Command.withDescription("Start an MCP server over stdio"));

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

const root = Command.make("executor").pipe(
  Command.withSubcommands([callCommand, resumeCommand, webCommand, mcpCommand] as const),
  Command.withDescription("Executor local CLI"),
);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const runCli = Command.run(root, {
  name: CLI_NAME,
  version: CLI_VERSION,
  executable: CLI_NAME,
});

const program = runCli(process.argv).pipe(
  Effect.catchAllCause((cause) =>
    Effect.sync(() => {
      console.error(Cause.pretty(cause));
      process.exitCode = 1;
    }),
  ),
);

BunRuntime.runMain(program as Effect.Effect<void, never, never>);
