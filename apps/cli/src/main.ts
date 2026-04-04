import { resolve, join } from "node:path";
import { Command, Options } from "@effect/cli";
import { BunRuntime } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";

import { createServerHandlers, runMcpStdioServer, getExecutor } from "@executor/server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_NAME = "executor";
const { version: CLI_VERSION } = await import("../package.json");
const DEFAULT_PORT = 8788;

const WEB_DIST_DIR = resolve(import.meta.dirname, "../../web/dist");

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
// Static file serving for the built web app
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const serveStatic = async (pathname: string): Promise<Response | null> => {
  const filePath = join(WEB_DIST_DIR, pathname);

  // Prevent directory traversal
  if (!filePath.startsWith(WEB_DIST_DIR)) return null;

  const file = Bun.file(filePath);
  if (await file.exists()) {
    const ext = pathname.slice(pathname.lastIndexOf("."));
    return new Response(file, {
      headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
    });
  }

  // SPA fallback — serve index.html for non-file paths
  const index = Bun.file(join(WEB_DIST_DIR, "index.html"));
  if (await index.exists()) {
    return new Response(index, {
      headers: { "content-type": "text/html" },
    });
  }

  return null;
};

// ---------------------------------------------------------------------------
// Foreground session — API + MCP + Web UI on one Bun.serve()
// ---------------------------------------------------------------------------

const runForegroundSession = (input: { kind: "web" | "mcp"; port: number }) =>
  Effect.gen(function* () {
    const handlers = yield* Effect.promise(() => createServerHandlers());

    const server = Bun.serve({
      port: input.port,
      async fetch(request) {
        const url = new URL(request.url);

        // MCP
        if (url.pathname.startsWith("/mcp")) {
          return handlers.mcp.handleRequest(request);
        }

        // API + docs
        if (
          url.pathname.startsWith("/v1/") ||
          url.pathname.startsWith("/docs") ||
          url.pathname === "/openapi.json"
        ) {
          return handlers.api.handler(request);
        }

        // Web UI static files
        const staticResponse = await serveStatic(url.pathname);
        if (staticResponse) return staticResponse;

        return new Response("Not Found", { status: 404 });
      },
    });

    const baseUrl = `http://localhost:${server.port}`;
    console.log(renderSessionSummary(input.kind, baseUrl));

    yield* waitForShutdownSignal();

    server.stop(true);
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
// Commands
// ---------------------------------------------------------------------------

const webCommand = Command.make(
  "web",
  {
    port: Options.integer("port").pipe(Options.withDefault(DEFAULT_PORT)),
  },
  ({ port }) => runForegroundSession({ kind: "web", port }),
).pipe(Command.withDescription("Start a foreground web session"));

const mcpCommand = Command.make(
  "mcp",
  {
    port: Options.integer("port").pipe(Options.withDefault(DEFAULT_PORT)),
    stdio: Options.boolean("stdio").pipe(Options.withDefault(false)),
    webPort: Options.integer("web-port").pipe(Options.optional),
  },
  ({ port, stdio, webPort }) =>
    stdio ? runStdioMcpSession() : runForegroundSession({ kind: "mcp", port }),
).pipe(
  Command.withDescription(
    "Start a foreground MCP session, or run stdio MCP with --stdio",
  ),
);

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

const root = Command.make("executor").pipe(
  Command.withSubcommands([webCommand, mcpCommand] as const),
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
