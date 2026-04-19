// Ensure binaries next to the executor (e.g. secure-exec-v8) are on $PATH
import { randomUUID } from "node:crypto";
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
import { FetchHttpClient, FileSystem, HttpApiClient, Path as PlatformPath } from "@effect/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";

import { ExecutorApi } from "@executor/api";
import { startServer, runMcpStdioServer, getExecutor } from "@executor/local";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";
import {
  buildDaemonSpawnSpec,
  chooseDaemonPort,
  canAutoStartLocalDaemonForHost,
  parseDaemonBaseUrl,
  spawnDetached,
  waitForReachable,
  waitForUnreachable,
} from "./daemon";
import {
  acquireDaemonStartLock,
  canonicalDaemonHost,
  currentDaemonScopeId,
  isPidAlive,
  readDaemonPointer,
  readDaemonRecord,
  releaseDaemonStartLock,
  removeDaemonPointer,
  removeDaemonRecord,
  terminatePid,
  writeDaemonPointer,
  writeDaemonRecord,
} from "./daemon-state";
import {
  buildDescribeToolCode,
  buildInvokeToolCode,
  buildListSourcesCode,
  buildRunToolQueryCode,
  buildSearchToolsCode,
  extractExecutionId,
  extractExecutionResult,
  parseJsonObjectInput,
} from "./tooling";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isServerReachable = (baseUrl: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => fetch(`${baseUrl}/api/scope`, { signal: AbortSignal.timeout(2000) })).pipe(
    Effect.flatMap((res) => {
      if (!res.ok) return Effect.succeed(false);
      return Effect.tryPromise(() => res.json()).pipe(
        Effect.map((payload) => {
          if (!isRecord(payload)) return false;
          return (
            typeof payload.id === "string" &&
            typeof payload.name === "string" &&
            typeof payload.dir === "string"
          );
        }),
        Effect.catchAll(() => Effect.succeed(false)),
      );
    }),
    Effect.catchAll(() => Effect.succeed(false)),
  );

const script = process.argv[1];
const isDevMode = script?.endsWith(".ts") || script?.endsWith(".js");
const cliPrefix = isDevMode ? `bun run ${script}` : "executor";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const parseDaemonUrl = (baseUrl: string) =>
  Effect.try({
    try: () => parseDaemonBaseUrl(baseUrl, DEFAULT_PORT),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(`Invalid base URL: ${String(cause)}`),
  });

const daemonBaseUrl = (hostname: string, port: number): string =>
  `http://${canonicalDaemonHost(hostname)}:${port}`;

const cleanupPointer = (input: { hostname: string; scopeId: string; port: number }) =>
  Effect.gen(function* () {
    yield* removeDaemonPointer({ hostname: input.hostname, scopeId: input.scopeId }).pipe(Effect.ignore);
    yield* removeDaemonRecord({ hostname: input.hostname, port: input.port }).pipe(Effect.ignore);
  });

const resolveDaemonTarget = (baseUrl: string) =>
  Effect.gen(function* () {
    const parsed = yield* parseDaemonUrl(baseUrl);
    const host = canonicalDaemonHost(parsed.hostname);
    const scopeId = currentDaemonScopeId();
    const pointer = yield* readDaemonPointer({ hostname: host, scopeId });

    if (pointer) {
      const pointerUrl = daemonBaseUrl(pointer.hostname, pointer.port);
      if (isPidAlive(pointer.pid) && (yield* isServerReachable(pointerUrl))) {
        return {
          baseUrl: pointerUrl,
          hostname: pointer.hostname,
          port: pointer.port,
          scopeId,
        };
      }

      yield* cleanupPointer({ hostname: pointer.hostname, scopeId, port: pointer.port });
    }

    return {
      baseUrl: daemonBaseUrl(host, parsed.port),
      hostname: host,
      port: parsed.port,
      scopeId,
    };
  });

const ensureDaemon = (
  baseUrl: string,
): Effect.Effect<string, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const resolvedTarget = yield* resolveDaemonTarget(baseUrl);
    if (yield* isServerReachable(resolvedTarget.baseUrl)) {
      return resolvedTarget.baseUrl;
    }

    const parsed = yield* parseDaemonUrl(baseUrl);
    const scopeId = currentDaemonScopeId();
    const host = canonicalDaemonHost(parsed.hostname);

    if (!canAutoStartLocalDaemonForHost(host)) {
      return yield* Effect.fail(
        new Error(
          [
            `Executor daemon is not reachable at ${baseUrl}.`,
            "Auto-start is only supported for local hosts.",
            `Start it manually: ${cliPrefix} daemon run --port ${parsed.port} --hostname ${host}`,
          ].join("\n"),
        ),
      );
    }

    const lock = yield* acquireDaemonStartLock({ hostname: host, scopeId });

    try {
      const existing = yield* resolveDaemonTarget(baseUrl);
      if (yield* isServerReachable(existing.baseUrl)) {
        return existing.baseUrl;
      }

      const selectedPort = yield* chooseDaemonPort({
        preferredPort: parsed.port,
        hostname: host,
      });

      if (selectedPort !== parsed.port) {
        console.error(
          `Port ${parsed.port} is in use. Starting daemon on available port ${selectedPort} instead.`,
        );
      }

      const spec = yield* Effect.try({
        try: () =>
          buildDaemonSpawnSpec({
            port: selectedPort,
            hostname: host,
            isDevMode,
            scriptPath: script,
            executablePath: process.execPath,
          }),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(`Failed to build daemon command: ${String(cause)}`),
      });

      const startBaseUrl = daemonBaseUrl(host, selectedPort);
      console.error(`Starting daemon on ${host}:${selectedPort}...`);
      yield* spawnDetached({
        command: spec.command,
        args: spec.args,
        env: process.env,
      });

      const ready = yield* waitForReachable({
        check: isServerReachable(startBaseUrl),
        timeoutMs: DAEMON_BOOT_TIMEOUT_MS,
        intervalMs: DAEMON_BOOT_POLL_MS,
      });

      if (!ready) {
        return yield* Effect.fail(
          new Error(
            [
              `Daemon did not become reachable at ${startBaseUrl} within ${DAEMON_BOOT_TIMEOUT_MS}ms.`,
              `Run in foreground to inspect logs: ${cliPrefix} daemon run --port ${selectedPort} --hostname ${host}`,
            ].join("\n"),
          ),
        );
      }

      return startBaseUrl;
    } finally {
      yield* releaseDaemonStartLock(lock).pipe(Effect.ignore);
    }
  }).pipe(Effect.mapError(toError));

const stopDaemon = (
  baseUrl: string,
): Effect.Effect<void, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const target = yield* resolveDaemonTarget(baseUrl);
    const host = canonicalDaemonHost(target.hostname);
    const scopeId = target.scopeId;
    const record = yield* readDaemonRecord({ hostname: host, port: target.port });
    const reachable = yield* isServerReachable(target.baseUrl);

    if (!record) {
      if (reachable) {
        return yield* Effect.fail(
          new Error(
            [
              `Executor is reachable at ${target.baseUrl} but no daemon record exists.`,
              "It may not be managed by this CLI process.",
              "Stop it from the terminal/session where it was started.",
            ].join("\n"),
          ),
        );
      }
      console.log(`No daemon running at ${target.baseUrl}.`);
      return;
    }

    if (!isPidAlive(record.pid)) {
      yield* removeDaemonRecord({ hostname: host, port: target.port });
      yield* removeDaemonPointer({ hostname: host, scopeId }).pipe(Effect.ignore);
      if (reachable) {
        return yield* Effect.fail(
          new Error(
            [
              `Daemon record for ${target.baseUrl} points to dead pid ${record.pid}, but endpoint is still reachable.`,
              "Refusing to stop an unknown process without ownership metadata.",
            ].join("\n"),
          ),
        );
      }
      console.log(`No daemon running at ${target.baseUrl} (removed stale record for pid ${record.pid}).`);
      return;
    }

    console.log(`Stopping daemon at ${target.baseUrl} (pid ${record.pid})...`);

    yield* terminatePid(record.pid);

    const stopped = yield* waitForUnreachable({
      check: isServerReachable(target.baseUrl),
      timeoutMs: DAEMON_STOP_TIMEOUT_MS,
      intervalMs: DAEMON_BOOT_POLL_MS,
    });

    if (!stopped) {
      return yield* Effect.fail(
        new Error(
          [
            `Daemon at ${target.baseUrl} did not stop within ${DAEMON_STOP_TIMEOUT_MS}ms.`,
            "Try terminating the process manually.",
          ].join("\n"),
        ),
      );
    }

    yield* removeDaemonRecord({ hostname: host, port: target.port });
    yield* removeDaemonPointer({ hostname: host, scopeId }).pipe(Effect.ignore);
    console.log(`Daemon stopped at ${target.baseUrl}.`);
  }).pipe(Effect.mapError(toError));

type ExecuteCodeOutcome =
  | {
      readonly status: "completed";
      readonly result: unknown;
    }
  | {
      readonly status: "paused";
      readonly text: string;
      readonly executionId: string | undefined;
    };

const executeCode = (input: {
  baseUrl: string;
  code: string;
}): Effect.Effect<ExecuteCodeOutcome, Error, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const daemonUrl = yield* ensureDaemon(input.baseUrl);
    const client = yield* makeApiClient(daemonUrl);
    const response = yield* client.executions.execute({
      payload: {
        code: input.code,
      },
    });

    if (response.status === "paused") {
      return {
        status: "paused" as const,
        text: response.text,
        executionId: extractExecutionId(response.structured),
      };
    }

    if (response.isError) {
      return yield* Effect.fail(new Error(response.text));
    }

    return {
      status: "completed" as const,
      result: extractExecutionResult(response.structured),
    };
  }).pipe(Effect.mapError(toError));

const printExecutionOutcome = (input: { baseUrl: string; outcome: ExecuteCodeOutcome }) =>
  Effect.sync(() => {
    if (input.outcome.status === "paused") {
      console.log(input.outcome.text);
      if (input.outcome.executionId) {
        console.log(
          `\nTo resume:\n  ${cliPrefix} resume --execution-id ${input.outcome.executionId} --action accept --base-url ${input.baseUrl}`,
        );
      }
      return;
    }

    if (typeof input.outcome.result === "string") {
      console.log(input.outcome.result);
      return;
    }

    console.log(JSON.stringify(input.outcome.result, null, 2));
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
    const daemonHost = canonicalDaemonHost(input.hostname);
    const scopeId = currentDaemonScopeId();
    const existing = yield* readDaemonPointer({ hostname: daemonHost, scopeId });

    if (existing) {
      const existingUrl = daemonBaseUrl(existing.hostname, existing.port);
      if (isPidAlive(existing.pid) && (yield* isServerReachable(existingUrl))) {
        return yield* Effect.fail(
          new Error(
            [
              `A daemon is already running for scope ${scopeId} on ${daemonHost}.`,
              `Existing daemon: ${existingUrl} (pid ${existing.pid}).`,
              `Stop it first: ${cliPrefix} daemon stop`,
            ].join("\n"),
          ),
        );
      }
      yield* cleanupPointer({ hostname: existing.hostname, scopeId, port: existing.port });
    }

    const server = yield* Effect.promise(() =>
      startServer({
        port: input.port,
        hostname: input.hostname,
        allowedHosts: input.allowedHosts,
        embeddedWebUI,
      }),
    );

    const daemonPort = server.port;
    const token = randomUUID();

    yield* writeDaemonRecord({
      hostname: daemonHost,
      port: daemonPort,
      pid: process.pid,
      scopeDir: process.env.EXECUTOR_SCOPE_DIR ?? null,
    });
    yield* writeDaemonPointer({
      hostname: daemonHost,
      port: daemonPort,
      pid: process.pid,
      scopeId,
      scopeDir: process.env.EXECUTOR_SCOPE_DIR ?? null,
      token,
    });

    console.log(`Daemon ready on http://${daemonHost}:${daemonPort}`);

    try {
      yield* waitForShutdownSignal();
    } finally {
      yield* Effect.promise(() => server.stop());
      yield* removeDaemonRecord({ hostname: daemonHost, port: daemonPort });
      yield* removeDaemonPointer({ hostname: daemonHost, scopeId }).pipe(Effect.ignore);
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
      const daemonUrl = yield* ensureDaemon(baseUrl);

      const client = yield* makeApiClient(daemonUrl);
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
      const daemonUrl = yield* ensureDaemon(baseUrl);

      const parsedContent = Option.getOrUndefined(content);
      const contentObj = parsedContent ? JSON.parse(parsedContent) : undefined;

      const client = yield* makeApiClient(daemonUrl);
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

const toolsSearchCommand = Command.make(
  "search",
  {
    query: Args.text({ name: "query" }),
    namespace: Options.text("namespace").pipe(Options.optional),
    limit: Options.integer("limit").pipe(Options.withDefault(12)),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ query, namespace, limit, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const code = buildSearchToolsCode({
        query,
        namespace: Option.getOrUndefined(namespace),
        limit,
      });

      const outcome = yield* executeCode({ baseUrl, code });
      yield* printExecutionOutcome({ baseUrl, outcome });
    }),
).pipe(Command.withDescription("Search tools by natural-language query"));

const toolsSourcesCommand = Command.make(
  "sources",
  {
    query: Options.text("query").pipe(Options.optional),
    limit: Options.integer("limit").pipe(Options.withDefault(50)),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ query, limit, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const code = buildListSourcesCode({
        query: Option.getOrUndefined(query),
        limit,
      });

      const outcome = yield* executeCode({ baseUrl, code });
      yield* printExecutionOutcome({ baseUrl, outcome });
    }),
).pipe(Command.withDescription("List configured sources and tool counts"));

const toolsDescribeCommand = Command.make(
  "describe",
  {
    path: Args.text({ name: "path" }),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ path, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const code = buildDescribeToolCode(path);
      const outcome = yield* executeCode({ baseUrl, code });
      yield* printExecutionOutcome({ baseUrl, outcome });
    }),
).pipe(Command.withDescription("Describe a tool's TypeScript and JSON schema"));

const toolsInvokeCommand = Command.make(
  "invoke",
  {
    path: Args.text({ name: "path" }),
    input: Options.text("input")
      .pipe(Options.optional)
      .pipe(Options.withDescription("JSON object arguments for the tool")),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ path, input, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const args = yield* parseJsonObjectInput(Option.getOrUndefined(input));
      const code = yield* Effect.try({
        try: () => buildInvokeToolCode(path, args),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(`Invalid tool path: ${String(cause)}`),
      });

      const outcome = yield* executeCode({ baseUrl, code });
      yield* printExecutionOutcome({ baseUrl, outcome });
    }),
).pipe(Command.withDescription("Invoke a tool by path (e.g. github.listIssues)"));

const toolsRunCommand = Command.make(
  "run",
  {
    query: Args.text({ name: "query" }),
    namespace: Options.text("namespace").pipe(Options.optional),
    limit: Options.integer("limit").pipe(Options.withDefault(12)),
    input: Options.text("input")
      .pipe(Options.optional)
      .pipe(Options.withDescription("JSON object arguments for the selected tool")),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_BASE_URL)),
    scope,
  },
  ({ query, namespace, limit, input, baseUrl, scope }) =>
    Effect.gen(function* () {
      applyScope(scope);
      const args = yield* parseJsonObjectInput(Option.getOrUndefined(input));
      const code = buildRunToolQueryCode({
        query,
        namespace: Option.getOrUndefined(namespace),
        args,
        limit,
      });

      const outcome = yield* executeCode({ baseUrl, code });
      yield* printExecutionOutcome({ baseUrl, outcome });
    }),
).pipe(
  Command.withDescription(
    "Search by query, pick the best tool match, and invoke it with JSON input",
  ),
);

const toolsCommand = Command.make("tools").pipe(
  Command.withSubcommands(
    [
      toolsSearchCommand,
      toolsSourcesCommand,
      toolsDescribeCommand,
      toolsInvokeCommand,
      toolsRunCommand,
    ] as const,
  ),
  Command.withDescription("Discover and invoke tools without writing JavaScript"),
);

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
      const target = yield* resolveDaemonTarget(baseUrl);
      const host = canonicalDaemonHost(target.hostname);

      const [record, reachable] = yield* Effect.all([
        readDaemonRecord({ hostname: host, port: target.port }),
        isServerReachable(target.baseUrl),
      ]);

      if (!record) {
        if (reachable) {
          console.log(`Daemon reachable at ${target.baseUrl} (no local ownership record).`);
        } else {
          console.log(`Daemon not running at ${target.baseUrl}.`);
        }
        return;
      }

      if (!isPidAlive(record.pid)) {
        if (!reachable) {
          yield* removeDaemonRecord({ hostname: host, port: target.port });
          yield* removeDaemonPointer({ hostname: host, scopeId: target.scopeId }).pipe(Effect.ignore);
          console.log(
            `Daemon not running at ${target.baseUrl} (removed stale record for pid ${record.pid}).`,
          );
          return;
        }
        console.log(
          `Daemon reachable at ${target.baseUrl}, but recorded pid ${record.pid} is not alive (ownership mismatch).`,
        );
        return;
      }

      const state = reachable ? "running" : "unreachable";
      console.log(`Daemon ${state} at ${target.baseUrl} (pid ${record.pid}).`);
      if (target.baseUrl !== baseUrl) {
        console.log(`Requested: ${baseUrl}`);
      }
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
      const daemonUrl = yield* ensureDaemon(baseUrl);
      console.log(`Daemon restarted at ${daemonUrl}.`);
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
  Command.withSubcommands(
    [callCommand, resumeCommand, toolsCommand, webCommand, daemonCommand, mcpCommand] as const,
  ),
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
