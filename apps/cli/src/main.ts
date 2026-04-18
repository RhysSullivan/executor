// Ensure binaries next to the executor (e.g. secure-exec-v8) are on $PATH
import { dirname, join, resolve } from "node:path";
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

import { Command, Options, Args } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { FetchHttpClient, FileSystem, HttpApiClient } from "@effect/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";

import { ExecutorApi } from "@executor/api";
import { startServer, runMcpStdioServer, getExecutor } from "@executor/local";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";
import {
  buildDaemonSpawnSpec,
  canAutoStartLocalDaemonForHost,
  parseDaemonBaseUrl,
  spawnDetached,
  waitForReachable,
  waitForUnreachable,
} from "./daemon";
import {
  canonicalDaemonHost,
  isPidAlive,
  readDaemonRecord,
  removeDaemonRecord,
  terminatePid,
  writeDaemonRecord,
} from "./daemon-state";

// Embedded web UI — baked into compiled binaries via `with { type: "file" }`
import embeddedWebUI from "./embedded-web-ui.gen";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_NAME = "executor";
const { version: CLI_VERSION } = await import("../package.json");
const DEFAULT_PORT = 4788;
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_PORT}`;
const DAEMON_BOOT_TIMEOUT_MS = 15_000;
const DAEMON_BOOT_POLL_MS = 150;
const DAEMON_STOP_TIMEOUT_MS = 10_000;

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

const isServerReachable = (baseUrl: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => fetch(`${baseUrl}/api/scope`, { signal: AbortSignal.timeout(2000) })).pipe(
    Effect.map((res) => res.ok),
    Effect.catchAll(() => Effect.succeed(false)),
  );

const script = process.argv[1];
const isDevMode = script?.endsWith(".ts") || script?.endsWith(".js");
const cliPrefix = isDevMode ? `bun run ${script}` : "executor";

const ensureDaemon = (baseUrl: string) =>
  Effect.gen(function* () {
    if (yield* isServerReachable(baseUrl)) return;

    const parsed = yield* Effect.try({
      try: () => parseDaemonBaseUrl(baseUrl, DEFAULT_PORT),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(`Invalid base URL: ${String(cause)}`),
    });

    if (!canAutoStartLocalDaemonForHost(parsed.hostname)) {
      return yield* Effect.fail(
        new Error(
          [
            `Executor daemon is not reachable at ${baseUrl}.`,
            "Auto-start is only supported for local hosts.",
            `Start it manually: ${cliPrefix} daemon run --port ${parsed.port} --hostname ${parsed.hostname}`,
          ].join("\n"),
        ),
      );
    }

    const spec = yield* Effect.try({
      try: () =>
        buildDaemonSpawnSpec({
          port: parsed.port,
          hostname: parsed.hostname,
          isDevMode,
          scriptPath: script,
          executablePath: process.execPath,
        }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(`Failed to build daemon command: ${String(cause)}`),
    });

    console.error(`Starting daemon on ${parsed.hostname}:${parsed.port}...`);
    yield* spawnDetached({
      command: spec.command,
      args: spec.args,
      env: process.env,
    });

    const ready = yield* waitForReachable({
      check: isServerReachable(baseUrl),
      timeoutMs: DAEMON_BOOT_TIMEOUT_MS,
      intervalMs: DAEMON_BOOT_POLL_MS,
    });

    if (!ready) {
      return yield* Effect.fail(
        new Error(
          [
            `Daemon did not become reachable at ${baseUrl} within ${DAEMON_BOOT_TIMEOUT_MS}ms.`,
            `Run in foreground to inspect logs: ${cliPrefix} daemon run --port ${parsed.port} --hostname ${parsed.hostname}`,
          ].join("\n"),
        ),
      );
    }
  });

const stopDaemon = (baseUrl: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseDaemonBaseUrl(baseUrl, DEFAULT_PORT),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(`Invalid base URL: ${String(cause)}`),
    });

    const host = canonicalDaemonHost(parsed.hostname);
    const record = yield* readDaemonRecord({ hostname: host, port: parsed.port });
    const reachable = yield* isServerReachable(baseUrl);

    if (!record) {
      if (reachable) {
        return yield* Effect.fail(
          new Error(
            [
              `Executor is reachable at ${baseUrl} but no daemon record exists.`,
              "It may not be managed by this CLI process.",
              "Stop it from the terminal/session where it was started.",
            ].join("\n"),
          ),
        );
      }
      console.log(`No daemon running at ${baseUrl}.`);
      return;
    }

    if (!isPidAlive(record.pid)) {
      yield* removeDaemonRecord({ hostname: host, port: parsed.port });
      if (reachable) {
        return yield* Effect.fail(
          new Error(
            [
              `Daemon record for ${baseUrl} points to dead pid ${record.pid}, but endpoint is still reachable.`,
              "Refusing to stop an unknown process without ownership metadata.",
            ].join("\n"),
          ),
        );
      }
      console.log(`No daemon running at ${baseUrl} (removed stale record for pid ${record.pid}).`);
      return;
    }

    console.log(`Stopping daemon at ${baseUrl} (pid ${record.pid})...`);

    yield* terminatePid(record.pid);

    const stopped = yield* waitForUnreachable({
      check: isServerReachable(baseUrl),
      timeoutMs: DAEMON_STOP_TIMEOUT_MS,
      intervalMs: DAEMON_BOOT_POLL_MS,
    });

    if (!stopped) {
      return yield* Effect.fail(
        new Error(
          [
            `Daemon at ${baseUrl} did not stop within ${DAEMON_STOP_TIMEOUT_MS}ms.`,
            "Try terminating the process manually.",
          ].join("\n"),
        ),
      );
    }

    yield* removeDaemonRecord({ hostname: host, port: parsed.port });
    console.log(`Daemon stopped at ${baseUrl}.`);
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

const runDaemonSession = (input: {
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

    const daemonHost = canonicalDaemonHost(input.hostname);
    const daemonPort = server.port;

    yield* writeDaemonRecord({
      hostname: daemonHost,
      port: daemonPort,
      pid: process.pid,
      scopeDir: process.env.EXECUTOR_SCOPE_DIR ?? null,
    });

    console.log(`Daemon ready on http://${daemonHost}:${daemonPort}`);

    try {
      yield* waitForShutdownSignal();
    } finally {
      yield* Effect.promise(() => server.stop());
      yield* removeDaemonRecord({ hostname: daemonHost, port: daemonPort });
    }
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
}): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const code = Option.getOrUndefined(input.code);
    if (code && code.trim().length > 0) return code;

    const file = Option.getOrUndefined(input.file);
    if (file && file.trim().length > 0) {
      const contents = yield* fs.readFileString(file).pipe(
        Effect.mapError((cause) => new Error(`Failed to read file: ${String(cause)}`)),
      );
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

const scope = Options.text("scope").pipe(
  Options.optional,
  Options.withDescription("Path to workspace directory containing executor.jsonc"),
);

const applyScope = (s: Option.Option<string>) => {
  const dir = Option.getOrUndefined(s);
  if (dir) process.env.EXECUTOR_SCOPE_DIR = resolve(dir);
};

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
    scope,
  },
  ({ code, file, stdin, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const resolvedCode = yield* readCode({ code, file, stdin });
      yield* ensureDaemon(baseUrl);

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
    scope,
  },
  ({ executionId, action, content, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      yield* ensureDaemon(baseUrl);

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

const daemonRunCommand = Command.make(
  "run",
  {
    port: Options.integer("port").pipe(Options.withDefault(DEFAULT_PORT)),
    hostname: Options.text("hostname")
      .pipe(Options.withDefault("127.0.0.1"))
      .pipe(Options.withDescription("Bind address. Keep this local unless you trust the network.")),
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
      yield* runDaemonSession({ port, hostname, allowedHosts: allowedHost });
    }),
).pipe(Command.withDescription("Run the local executor daemon"));

const daemonStatusCommand = Command.make(
  "status",
  {
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
  },
  ({ baseUrl }) =>
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => parseDaemonBaseUrl(baseUrl, DEFAULT_PORT),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(`Invalid base URL: ${String(cause)}`),
      });
      const host = canonicalDaemonHost(parsed.hostname);

      const [record, reachable] = yield* Effect.all([
        readDaemonRecord({ hostname: host, port: parsed.port }),
        isServerReachable(baseUrl),
      ]);

      if (!record) {
        if (reachable) {
          console.log(`Daemon reachable at ${baseUrl} (no local ownership record).`);
        } else {
          console.log(`Daemon not running at ${baseUrl}.`);
        }
        return;
      }

      if (!isPidAlive(record.pid)) {
        if (!reachable) {
          yield* removeDaemonRecord({ hostname: host, port: parsed.port });
          console.log(`Daemon not running at ${baseUrl} (removed stale record for pid ${record.pid}).`);
          return;
        }
        console.log(
          `Daemon reachable at ${baseUrl}, but recorded pid ${record.pid} is not alive (ownership mismatch).`,
        );
        return;
      }

      const state = reachable ? "running" : "unreachable";
      console.log(`Daemon ${state} at ${baseUrl} (pid ${record.pid}).`);
      if (record.scopeDir) {
        console.log(`Scope: ${record.scopeDir}`);
      }
    }),
).pipe(Command.withDescription("Show daemon status"));

const daemonStopCommand = Command.make(
  "stop",
  {
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
  },
  ({ baseUrl }) => stopDaemon(baseUrl),
).pipe(Command.withDescription("Stop the local daemon"));

const daemonRestartCommand = Command.make(
  "restart",
  {
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      yield* stopDaemon(baseUrl);
      yield* ensureDaemon(baseUrl);
      console.log(`Daemon restarted at ${baseUrl}.`);
    }),
).pipe(Command.withDescription("Restart the local daemon"));

const daemonCommand = Command.make("daemon").pipe(
  Command.withSubcommands(
    [daemonRunCommand, daemonStatusCommand, daemonStopCommand, daemonRestartCommand] as const,
  ),
  Command.withDescription("Manage the local daemon"),
);

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
  Command.withSubcommands([callCommand, resumeCommand, webCommand, daemonCommand, mcpCommand] as const),
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
  Effect.provide(BunContext.layer),
  Effect.catchAllCause((cause) =>
    Effect.sync(() => {
      console.error(Cause.pretty(cause));
      process.exitCode = 1;
    }),
  ),
);

BunRuntime.runMain(program as Effect.Effect<void, never, never>);
