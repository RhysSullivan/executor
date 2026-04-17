// Ensure binaries next to the executor (e.g. secure-exec-v8) are on $PATH
import { dirname, join } from "node:path";
const execDir = dirname(process.execPath);
if (process.env.PATH && !process.env.PATH.includes(execDir)) {
  process.env.PATH = `${execDir}:${process.env.PATH}`;
}

// Pre-load QuickJS WASM for compiled binaries — must run before server imports
const wasmOnDisk = join(execDir, "emscripten-module.wasm");
if (typeof Bun !== "undefined" && (await Bun.file(wasmOnDisk).exists())) {
  const { setQuickJSModule } = await import("@executor/runtime-quickjs");
  const { newQuickJSWASMModule } = await import("quickjs-emscripten");
  const wasmBinary = await Bun.file(wasmOnDisk).arrayBuffer();
  const variant = {
    type: "sync" as const,
    importFFI: () =>
      import("@jitl/quickjs-wasmfile-release-sync/ffi").then(
        (m: Record<string, unknown>) => m.QuickJSFFI,
      ),
    importModuleLoader: () =>
      import("@jitl/quickjs-wasmfile-release-sync/emscripten-module").then(
        (m: Record<string, unknown>) => {
          const original = m.default as (...args: unknown[]) => unknown;
          return (moduleArg: Record<string, unknown> = {}) =>
            original({ ...moduleArg, wasmBinary });
        },
      ),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- quickjs-emscripten variant type is not publicly exported
  const mod = await newQuickJSWASMModule(variant as any);
  setQuickJSModule(mod);
}

import { resolve } from "node:path";
import { Command, Options, Args } from "@effect/cli";
import { BunRuntime } from "@effect/platform-bun";
import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";

import { ExecutorApi } from "@executor/api";
import { startServer, runMcpStdioServer, getExecutor } from "@executor/local";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";

// Embedded web UI — baked into compiled binaries via `with { type: "file" }`
import embeddedWebUI from "./embedded-web-ui.gen";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_NAME = "executor";
const { version: CLI_VERSION } = await import("../package.json");
const DEFAULT_PORT = 4788;
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_PORT}`;

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

// ---------------------------------------------------------------------------
// Background server management
// ---------------------------------------------------------------------------

const isServerReachable = async (baseUrl: string): Promise<boolean> => {
  try {
    const res = await fetch(`${baseUrl}/api/scope`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
};

const script = process.argv[1];
const isDevMode = script?.endsWith(".ts") || script?.endsWith(".js");
const cliPrefix = isDevMode ? `bun run ${script}` : "executor";

const ensureServer = (baseUrl: string) =>
  Effect.gen(function* () {
    if (yield* Effect.promise(() => isServerReachable(baseUrl))) return;

    // Start server in-process instead of spawning a background child.
    // This is more reliable across environments (containers, sandboxes, etc.)
    const url = new URL(baseUrl);
    const port = Number(url.port) || DEFAULT_PORT;
    console.error(`Starting server on port ${port}...`);
    yield* Effect.promise(() => startServer({ port, embeddedWebUI }));
  });

// ---------------------------------------------------------------------------
// Typed API client
// ---------------------------------------------------------------------------

const makeApiClient = (baseUrl: string) =>
  HttpApiClient.make(ExecutorApi, { baseUrl: `${baseUrl}/api` }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );

// ---------------------------------------------------------------------------
// Foreground session
// ---------------------------------------------------------------------------

const runForegroundSession = (input: {
  port: number;
  hostname: string;
  allowedHosts: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const server = yield* Effect.promise(() =>
      startServer({
        port: input.port,
        hostname: input.hostname,
        allowedHosts: input.allowedHosts,
        embeddedWebUI,
      }),
    );

    const displayHost =
      input.hostname === "0.0.0.0" || input.hostname === "::" ? "localhost" : input.hostname;
    const baseUrl = `http://${displayHost}:${server.port}`;
    console.log(`Executor is ready.`);
    console.log(`Web:     ${baseUrl}`);
    console.log(`MCP:     ${baseUrl}/mcp`);
    console.log(`OpenAPI: ${baseUrl}/api/docs`);
    if (input.hostname !== "127.0.0.1" && input.hostname !== "localhost") {
      console.log(
        `\n⚠  Listening on ${input.hostname}. Executor runs arbitrary commands — only expose on trusted networks.`,
      );
      if (input.allowedHosts.length > 0) {
        console.log(`   Extra allowed Host headers: ${input.allowedHosts.join(", ")}`);
      }
    }
    console.log(`\nPress Ctrl+C to stop.`);

    yield* waitForShutdownSignal();
    yield* Effect.promise(() => server.stop());
  });

// ---------------------------------------------------------------------------
// Stdio MCP session
// ---------------------------------------------------------------------------

const runStdioMcpSession = () =>
  Effect.gen(function* () {
    const executor = yield* Effect.promise(() => getExecutor());
    yield* Effect.promise(() =>
      runMcpStdioServer({ executor, codeExecutor: makeQuickJsExecutor() }),
    );
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
          process.exit(1);
        } else {
          console.log(result.text);
          process.exit(0);
        }
      } else {
        console.log(result.text);
        const executionId = (result.structured as Record<string, unknown> | undefined)?.executionId;
        if (executionId) {
          console.log(
            `\nTo resume:\n  ${cliPrefix} resume --execution-id ${executionId} --action accept`,
          );
        }
        process.exit(0);
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
        process.exit(1);
      } else {
        console.log(result.text);
        process.exit(0);
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
    hostname: Options.text("hostname")
      .pipe(Options.withDefault("127.0.0.1"))
      .pipe(Options.withDescription("Bind address. Use 0.0.0.0 to listen on all interfaces.")),
    allowedHost: Options.text("allowed-host")
      .pipe(Options.repeated)
      .pipe(
        Options.withDescription(
          "Additional hostname permitted in the Host header (repeatable). localhost/127.0.0.1 are always allowed.",
        ),
      ),
    scope,
  },
  ({ port, scope, hostname, allowedHost }) =>
    Effect.gen(function* () {
      applyScope(scope);
      yield* runForegroundSession({ port, hostname, allowedHosts: allowedHost });
    }),
).pipe(Command.withDescription("Start a foreground web session"));

const mcpCommand = Command.make("mcp", { scope }, ({ scope }) =>
  Effect.gen(function* () {
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

if (process.argv.includes("-v")) {
  console.log(CLI_VERSION);
  process.exit(0);
}

const program = runCli(process.argv).pipe(
  Effect.catchAllCause((cause) =>
    Effect.sync(() => {
      console.error(Cause.pretty(cause));
      process.exitCode = 1;
    }),
  ),
);

BunRuntime.runMain(program as Effect.Effect<void, never, never>);
