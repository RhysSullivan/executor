import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { FileSystem } from "@effect/platform";
import { Args, Command, Options } from "@effect/cli";
import {
  NodeFileSystem,
  NodePath,
  NodeRuntime,
} from "@effect/platform-node";
import {
  createExecutorApiClient,
  type ExecutorApiClient,
} from "@executor/platform-api";
import { createWorkspaceExecutorAdminToolMap } from "@executor/platform-internal";
import {
  EXECUTOR_SOURCES_ADD_HELP_LINES,
  RuntimeExecutionResolverService,
} from "@executor/platform-sdk/runtime";
import {
  createExecutorEffect,
  type Executor,
} from "@executor/platform-sdk";
import { createLocalExecutorBackend } from "@executor/platform-sdk-file";
import {
  ExecutionIdSchema,
  type ExecutionEnvelope,
  type ExecutionInteraction,
} from "@executor/platform-sdk/schema";
import type { ToolCatalog } from "@executor/codemode-core";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";

import {
  DEFAULT_SERVER_BASE_URL,
  DEFAULT_SERVER_HOST,
  DEFAULT_LOCAL_DATA_DIR,
  DEFAULT_SERVER_LOG_FILE,
  DEFAULT_SERVER_PID_FILE,
  DEFAULT_SERVER_PORT,
  SERVER_POLL_INTERVAL_MS,
  SERVER_START_TIMEOUT_MS,
  runLocalExecutorServer,
} from "@executor/server";
import {
  seedDemoMcpSourceInWorkspace,
  seedGithubOpenApiSourceInWorkspace,
} from "./dev";
import {
  resolveRuntimeWebAssetsDir,
  resolveSelfCommand,
} from "./runtime-paths";
import {
  buildPausedExecutionOutput,
  parseInteractionPayload,
} from "./pending-interaction-output";
import { decideInteractionHandling } from "./interaction-handling";
import {
  executorAppEffectError,
  type LocalServerReachabilityTimeoutError,
  localServerReachabilityTimeoutError,
} from "../effect-errors";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const openUrlInBrowser = (url: string): Effect.Effect<void, never, never> =>
  Effect.sync(() => {
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];

    try {
      const child = spawn(cmd[0]!, cmd.slice(1), {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // Best-effort browser launch only; always leave the URL in stdout.
    }
  }).pipe(Effect.catchAll(() => Effect.void));

const promptLine = (prompt: string): Effect.Effect<string, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    catch: toError,
  });

const readStdin = (): Effect.Effect<string, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      let contents = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        contents += chunk;
      }
      return contents;
    },
    catch: toError,
  });

const readCode = (input: {
  code?: string;
  file?: string;
  stdin?: boolean;
}): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (input.code && input.code.trim().length > 0) {
      return input.code;
    }

    if (input.file && input.file.trim().length > 0) {
      const fs = yield* FileSystem.FileSystem;
      const contents = yield* fs.readFileString(input.file!, "utf8").pipe(
        Effect.mapError(toError),
      );
      if (contents.trim().length > 0) {
        return contents;
      }
    }

    const shouldReadStdin = input.stdin === true || !process.stdin.isTTY;
    if (shouldReadStdin) {
      const contents = yield* readStdin();
      if (contents.trim().length > 0) {
        return contents;
      }
    }

    return yield* executorAppEffectError("cli/main", "Provide code as a positional argument, use --file, or pipe code over stdin.");
  });

const getBootstrapClient = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  createExecutorApiClient({ baseUrl });

const decodeExecutionId = Schema.decodeUnknown(ExecutionIdSchema);
const require = createRequire(import.meta.url);
const CLI_NAME = "executor";
const CLI_VERSION = (() => {
  const candidatePaths = [
    "../package.json",
    "../../package.json",
  ];

  for (const candidatePath of candidatePaths) {
    try {
      const metadata = require(candidatePath) as { version?: string };
      if (metadata.version && metadata.version.trim().length > 0) {
        return metadata.version;
      }
    } catch {
      // Fall through to the default version below.
    }
  }

  return "0.0.0-local";
})();
const HELP_TOKENS = ["--help", "-h", "help"] as const;

const isHelpToken = (value: string | undefined): boolean =>
  value !== undefined && HELP_TOKENS.includes(value as (typeof HELP_TOKENS)[number]);

const normalizeCliArgs = (rawArgs: readonly string[]): string[] => {
  return rawArgs[0] === "run"
    ? ["call", ...rawArgs.slice(1)]
    : [...rawArgs];
};

const getCliArgs = (): string[] => normalizeCliArgs(process.argv.slice(2));

const toEffectCliArgv = (args: readonly string[]): string[] => [
  process.execPath || CLI_NAME,
  CLI_NAME,
  ...args,
];

const buildWorkflowText = (namespaces: readonly string[] = []): string =>
  [
    "Execute TypeScript in sandbox; call tools via discovery workflow.",
    ...(namespaces.length > 0
      ? [
          "Available namespaces:",
          ...namespaces.map((namespace) => `- ${namespace}`),
        ]
      : []),
    "Workflow:",
    '1) const matches = await tools.discover({ query: "<intent>", limit: 12 });',
    "2) const details = await tools.describe.tool({ path, includeSchemas: true });",
    "3) Call selected tools.<path>(input).",
    '4) To connect a source, call tools.executor.sources.add(...) for MCP, OpenAPI, or GraphQL APIs.',
    ...EXECUTOR_SOURCES_ADD_HELP_LINES,
    "5) If execution pauses for interaction, resume it with `executor resume --execution-id ...`.",
    "Do not use fetch; use tools.* only.",
  ].join("\n");

const DEFAULT_RUN_WORKFLOW = buildWorkflowText();

const indentBlock = (value: string, prefix: string = "  "): string =>
  value
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : ""))
    .join("\n");

const formatCauseMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure instanceof Error && failure.message.length > 0) {
    return failure.message;
  }
  if (typeof failure === "string" && failure.length > 0) {
    return failure;
  }

  const defect = Option.getOrUndefined(Cause.dieOption(cause));
  if (defect instanceof Error && defect.message.length > 0) {
    return defect.message;
  }
  if (typeof defect === "string" && defect.length > 0) {
    return defect;
  }

  return Cause.pretty(cause).split("\n").find((line) => line.trim().length > 0) ?? "unknown error";
};

const formatCatalogUnavailableMessage = (cause: Cause.Cause<unknown>): string => {
  const message = formatCauseMessage(cause);
  return message === "Error: An error has occurred"
    ? "Current workspace catalog unavailable."
    : `Current workspace catalog unavailable: ${message}`;
};

const closeExecutor = (executor: Executor) =>
  Effect.tryPromise({
    try: () => executor.close(),
    catch: toError,
  }).pipe(Effect.catchAll(() => Effect.void));

const buildRunWorkflowText = (
  catalog?: ToolCatalog,
): Effect.Effect<string, Error, never> => {
  if (!catalog) {
    return Effect.succeed(DEFAULT_RUN_WORKFLOW);
  }

  return catalog.listNamespaces({ limit: 200 }).pipe(
    Effect.map((namespaces) =>
      buildWorkflowText(
        namespaces.length > 0
          ? namespaces.map((namespace) => namespace.displayName ?? namespace.namespace)
          : ["none discovered yet"],
      )
    ),
    Effect.mapError(toError),
  );
};

const loadRunWorkflowText = (): Effect.Effect<string, Error, never> =>
  Effect.acquireUseRelease(
    createExecutorEffect({
      backend: createLocalExecutorBackend({
        localDataDir: DEFAULT_LOCAL_DATA_DIR,
      }),
      createInternalToolMap: createWorkspaceExecutorAdminToolMap,
    }).pipe(Effect.mapError(toError)),
    (executor) =>
      Effect.gen(function* () {
        const environment = yield* Effect.gen(function* () {
          const resolveExecutionEnvironment = yield* RuntimeExecutionResolverService;
          return yield* resolveExecutionEnvironment({
            workspaceId: executor.workspaceId,
            accountId: executor.accountId,
            executionId: ExecutionIdSchema.make("exec_help"),
          });
        }).pipe(
          Effect.provide(executor.runtime.runtimeLayer),
          Effect.mapError(toError),
        );

        return yield* buildRunWorkflowText(environment.catalog);
      }),
    closeExecutor,
  ).pipe(
    Effect.catchAllCause((cause) =>
      Effect.succeed(
        [
          DEFAULT_RUN_WORKFLOW,
          "",
          formatCatalogUnavailableMessage(cause),
        ].join("\n"),
      )
    ),
  );

const printRootHelp = (workflow: string) =>
  Effect.sync(() => {
    console.log([
      `${CLI_NAME} ${CLI_VERSION}`,
      "",
      "USAGE",
      "",
      "  executor call [code] [--file text] [--stdin] [--base-url text] [--no-open]",
      "  executor resume --execution-id text [--base-url text] [--no-open]",
      "",
      "CALL WORKFLOW",
      "",
      indentBlock(workflow),
      "",
      "COMMANDS",
      "",
      "  call",
      "    Execute code against the local executor server.",
      "  resume",
      "    Resume a paused execution.",
      "",
      "TIP",
      "",
      "  Run `executor call --help` for more examples.",
    ].join("\n"));
  });

const printCallHelp = (workflow: string) =>
  Effect.sync(() => {
    console.log([
      "executor call",
      "",
      "USAGE",
      "",
      "  executor call [code] [--file text] [--stdin] [--base-url text] [--no-open]",
      "",
      "DESCRIPTION",
      "",
      "  Execute code against the local executor server.",
      "",
      "WORKFLOW",
      "",
      indentBlock(workflow),
      "",
      "OPTIONS",
      "",
      "  [code]",
      "    Inline code to execute.",
      "  --file text",
      "    Read code from a file.",
      "  --stdin",
      "    Read code from stdin.",
      "  --base-url text",
      "    Override the executor server base URL.",
      "  --no-open",
      "    Print interaction URLs without opening a browser.",
      "",
      "EXAMPLES",
      "",
      '  executor call \'const matches = await tools.discover({ query: "github issues", limit: 5 }); return matches;\'',
      '  executor call \'const matches = await tools.discover({ query: "repo details", limit: 1 }); const path = matches.bestPath; return await tools.describe.tool({ path, includeSchemas: true });\'',
      '  executor call \'return await tools.executor.sources.add({ endpoint: "https://example.com/mcp", name: "Example", namespace: "example" });\'',
      '  executor call \'return await tools.executor.sources.add({ kind: "openapi", endpoint: "https://api.github.com", specUrl: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json", name: "GitHub", namespace: "github" });\'',
      "  cat script.ts | executor call --stdin",
      "  executor call --file script.ts",
      "  executor call --no-open --file script.ts",
      "  executor resume --execution-id exec_123",
    ].join("\n"));
  });

const helpOverride = (): Effect.Effect<void, Error, never> | null => {
  const args = getCliArgs();

  if (args.length === 0 || (args.length === 1 && isHelpToken(args[0]))) {
    return loadRunWorkflowText().pipe(Effect.flatMap(printRootHelp));
  }

  if (args[0] === "call" && args.length === 2 && isHelpToken(args[1])) {
    return loadRunWorkflowText().pipe(Effect.flatMap(printCallHelp));
  }

  return null;
};

const getLocalAuthedClient = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  Effect.gen(function* () {
    const bootstrapClient = yield* getBootstrapClient(baseUrl);
    const installation = yield* bootstrapClient.local.installation({});
    const client = yield* createExecutorApiClient({
      baseUrl,
      accountId: installation.accountId,
    });

    return {
      installation,
      client,
    } as const;
  });

const isServerReachable = (baseUrl: string) =>
  getBootstrapClient(baseUrl).pipe(
    Effect.flatMap((client) => client.local.installation({})),
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  );

const getDefaultServerOptions = (port: number = DEFAULT_SERVER_PORT) => {
  const assetsDir = resolveRuntimeWebAssetsDir();

  return {
    host: DEFAULT_SERVER_HOST,
    port,
    localDataDir: DEFAULT_LOCAL_DATA_DIR,
    pidFile: DEFAULT_SERVER_PID_FILE,
    ui: assetsDir ? { assetsDir } : undefined,
  };
};

const startServerInBackground = (port: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const command = resolveSelfCommand(["__local-server", "--port", String(port)]);
      yield* fs.makeDirectory(dirname(DEFAULT_SERVER_LOG_FILE), {
        recursive: true,
      }).pipe(Effect.mapError(toError));
      const logHandle = yield* fs.open(DEFAULT_SERVER_LOG_FILE, {
        flag: "a",
      }).pipe(Effect.mapError(toError));

      yield* Effect.try({
        try: () => {
          const fd = Number(logHandle.fd);
          const child = spawn(command[0]!, command.slice(1), {
            detached: true,
            stdio: ["ignore", fd, fd],
          });
          child.unref();
        },
        catch: toError,
      });
    }),
  );

type LocalServerPidRecord = {
  pid?: number;
  port?: number;
  host?: string;
  baseUrl?: string;
  startedAt?: number;
  logFile?: string;
};

const readPidRecord = (): Effect.Effect<
  LocalServerPidRecord | null,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(DEFAULT_SERVER_PID_FILE, "utf8").pipe(
      Effect.catchAll(() => Effect.succeed<string | null>(null)),
    );
    if (contents === null) {
      return null;
    }

    return JSON.parse(contents) as LocalServerPidRecord;
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

const isPidRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};


const readServerLogTail = (
  logFile: string = DEFAULT_SERVER_LOG_FILE,
  maxLines: number = 40,
  maxChars: number = 6000,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(logFile, "utf8").pipe(
      Effect.catchAll(() => Effect.succeed<string | null>(null)),
    );

    if (contents === null) {
      return null;
    }

    const lines = contents.split(/\r?\n/u).filter((line) => line.length > 0);
    const tail = lines.slice(-maxLines).join("\n");
    return tail.length > maxChars ? tail.slice(-maxChars) : tail;
  });

const failReachabilityTimeout = (input: {
  baseUrl: string;
  expected: boolean;
  logFile?: string;
}): Effect.Effect<never, LocalServerReachabilityTimeoutError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const logFile = input.logFile ?? DEFAULT_SERVER_LOG_FILE;
    const logTail = yield* readServerLogTail(logFile);

    return yield* localServerReachabilityTimeoutError({
      baseUrl: input.baseUrl,
      expected: input.expected,
      logFile,
      logTail,
    });
  });

const waitForReachability = (baseUrl: string, expected: boolean) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
      const reachable = yield* isServerReachable(baseUrl);
      if (reachable === expected) {
        return;
      }
      yield* sleep(SERVER_POLL_INTERVAL_MS);
    }

    return yield* failReachabilityTimeout({ baseUrl, expected });
  });

type LocalServerStatus = {
  baseUrl: string;
  reachable: boolean;
  pidFile: string;
  pid: number | null;
  pidRunning: boolean;
  logFile: string;
  localDataDir: string;
  webAssetsDir: string | null;
  installation: {
    accountId: string;
    workspaceId: string;
  } | null;
  denoVersion: string | null;
};

const renderDenoSandboxDetail = (denoVersion: string | null): string =>
  denoVersion !== null
    ? `deno ${denoVersion}`
    : "deno not found (run `executor sandbox` to install)";

const getServerStatus = (
  baseUrl: string,
): Effect.Effect<LocalServerStatus, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const pidRecord = yield* readPidRecord();
    const reachable = yield* isServerReachable(baseUrl);
    const installation = reachable
      ? yield* getBootstrapClient(baseUrl).pipe(
          Effect.flatMap((client) => client.local.installation({})),
          Effect.catchAll(() => Effect.succeed(null)),
        )
      : null;

    const pid = typeof pidRecord?.pid === "number" ? pidRecord.pid : null;
    const pidRunning = pid !== null ? isPidRunning(pid) : false;
    const logFile = pidRecord?.logFile ?? DEFAULT_SERVER_LOG_FILE;
    const denoVersion = yield* getDenoVersion();

    return {
      baseUrl,
      reachable,
      pidFile: DEFAULT_SERVER_PID_FILE,
      pid,
      pidRunning,
      logFile,
      localDataDir: DEFAULT_LOCAL_DATA_DIR,
      webAssetsDir: resolveRuntimeWebAssetsDir(),
      installation,
      denoVersion,
    } satisfies LocalServerStatus;
  });

const renderStatus = (status: LocalServerStatus): string =>
  [
    `baseUrl: ${status.baseUrl}`,
    `reachable: ${status.reachable ? "yes" : "no"}`,
    `pid: ${status.pid ?? "none"}`,
    `pidRunning: ${status.pidRunning ? "yes" : "no"}`,
    `pidFile: ${status.pidFile}`,
    `logFile: ${status.logFile}`,
    `localDataDir: ${status.localDataDir}`,
    `webAssetsDir: ${status.webAssetsDir ?? "missing"}`,
    `workspaceId: ${status.installation?.workspaceId ?? "unavailable"}`,
    `denoSandbox: ${renderDenoSandboxDetail(status.denoVersion)}`,
  ].join("\n");

const getDoctorReport = (baseUrl: string) =>
  getServerStatus(baseUrl).pipe(
    Effect.map((status) => {
      const checks = {
        serverReachable: {
          ok: status.reachable,
          detail: status.reachable ? `reachable at ${status.baseUrl}` : `not reachable at ${status.baseUrl}`,
        },
        pidFile: {
          ok: status.pid !== null,
          detail: status.pid !== null ? `pid ${status.pid}` : `missing pid file at ${status.pidFile}`,
        },
        process: {
          ok: status.pidRunning,
          detail: status.pidRunning ? `pid ${status.pid}` : "no live daemon process recorded",
        },
        database: {
          ok: status.localDataDir.length > 0,
          detail: status.localDataDir,
        },
        webAssets: {
          ok: status.webAssetsDir !== null,
          detail: status.webAssetsDir ?? "missing bundled web assets",
        },
        installation: {
          ok: status.installation !== null,
          detail: status.installation
            ? `workspace ${status.installation.workspaceId}`
            : "local installation unavailable",
        },
        denoSandbox: {
          ok: status.denoVersion !== null,
          detail: renderDenoSandboxDetail(status.denoVersion),
        },
      } as const;

      return {
        ok: Object.values(checks).every((check) => check.ok),
        status,
        checks,
      };
    }),
  );

const printJson = (value: unknown) =>
  Effect.sync(() => {
    console.log(JSON.stringify(value, null, 2));
  });

const printText = (value: string) =>
  Effect.sync(() => {
    console.log(value);
  });

const stopServer = (baseUrl: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const removePidFile = fs.remove(DEFAULT_SERVER_PID_FILE, {
      force: true,
    }).pipe(Effect.ignore);
    const pidRecord = yield* readPidRecord();
    const pid = typeof pidRecord?.pid === "number" ? pidRecord.pid : null;

    if (pid === null) {
      yield* removePidFile;
      return false;
    }

    if (!isPidRunning(pid)) {
      yield* removePidFile;
      return false;
    }


    yield* Effect.sync(() => {
      process.kill(pid, "SIGTERM");
    });

    yield* waitForReachability(baseUrl, false).pipe(
      Effect.catchAll(() =>
        removePidFile.pipe(
          Effect.ignore,
          Effect.zipRight(Effect.fail(executorAppEffectError("cli/main", `Timed out stopping local executor server pid ${pid}`))),
        ),
      ),
    );

    return true;
  });

const ensureServer = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  Effect.gen(function* () {
    const reachable = yield* isServerReachable(baseUrl);
    if (reachable) {
      return;
    }

    const url = new URL(baseUrl);
    const port = Number(url.port || DEFAULT_SERVER_PORT);
    yield* startServerInBackground(port);

    yield* waitForReachability(baseUrl, true);
  });



const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type PromptField = {
  name: string;
  label: string;
  description?: string;
  type: string;
  required: boolean;
  enumValues?: readonly unknown[];
};

const getPromptFields = (requestedSchema: Record<string, unknown> | undefined): PromptField[] => {
  if (!requestedSchema || !isRecord(requestedSchema.properties)) {
    return [];
  }

  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  return Object.entries(requestedSchema.properties).flatMap(([name, property]) => {
    if (!isRecord(property)) {
      return [];
    }

    return [{
      name,
      label:
        typeof property.title === "string" && property.title.trim().length > 0
          ? property.title.trim()
          : name,
      description:
        typeof property.description === "string" && property.description.trim().length > 0
          ? property.description.trim()
          : undefined,
      type: typeof property.type === "string" ? property.type : "string",
      required: required.has(name),
      enumValues: Array.isArray(property.enum) ? property.enum : undefined,
    }];
  });
};

const parsePromptValue = (field: PromptField, raw: string):
  | { ok: true; value: unknown }
  | { ok: false; message: string } => {
  if (field.enumValues && field.enumValues.length > 0) {
    const normalized = field.enumValues.map((value) => String(value));
    if (!normalized.includes(raw)) {
      return {
        ok: false,
        message: `Enter one of: ${normalized.join(", ")}`,
      };
    }
  }

  if (field.type === "boolean") {
    const normalized = raw.trim().toLowerCase();
    if (["y", "yes", "true"].includes(normalized)) {
      return { ok: true, value: true };
    }
    if (["n", "no", "false"].includes(normalized)) {
      return { ok: true, value: false };
    }
    return { ok: false, message: "Enter yes or no" };
  }

  if (field.type === "number" || field.type === "integer") {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return { ok: false, message: "Enter a number" };
    }
    if (field.type === "integer" && !Number.isInteger(value)) {
      return { ok: false, message: "Enter an integer" };
    }
    return { ok: true, value };
  }

  if (field.type === "object" || field.type === "array") {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false, message: "Enter valid JSON" };
    }
  }

  return { ok: true, value: raw };
};

const promptStructuredInteraction = (parsed: {
  message: string;
  requestedSchema?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const fields = getPromptFields(parsed.requestedSchema);
    if (fields.length === 0) {
      return null as Record<string, unknown> | null;
    }

    yield* Effect.sync(() => {
      process.stdout.write(`${parsed.message}\n`);
    });

    const content: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.description) {
        yield* Effect.sync(() => {
          process.stdout.write(`${field.description}\n`);
        });
      }

      while (true) {
        const raw = yield* promptLine(
          `${field.label}${field.required ? "" : " (optional)"}: `,
        );
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          if (field.required) {
            return null;
          }
          break;
        }

        const parsedValue = parsePromptValue(field, trimmed);
        if (parsedValue.ok) {
          content[field.name] = parsedValue.value;
          break;
        }

        yield* Effect.sync(() => {
          process.stdout.write(`${parsedValue.message}\n`);
        });
      }
    }

    return content;
  });

const printUrlInteraction = (input: {
  message: string;
  url: string | null;
  shouldOpen: boolean;
}) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      process.stdout.write(`${input.message}\n${input.url ?? ""}\n`);
    });

    if (input.shouldOpen && input.url) {
      yield* openUrlInBrowser(input.url);
    }
  });

const executionInteractionMode = (): "live_form" | "detach" =>
  process.stdin.isTTY && process.stdout.isTTY ? "live_form" : "detach";

const promptInteraction = (input: {
  interaction: ExecutionInteraction;
  shouldOpenUrls: boolean;
}) =>
  Effect.gen(function* () {
    const parsed = parseInteractionPayload(input.interaction);

    if (!process.stdin.isTTY || !process.stdout.isTTY || parsed === null) {
      return null;
    }

    if (parsed.mode === "url") {
      yield* printUrlInteraction({
        message: parsed.message,
        url: parsed.url ?? null,
        shouldOpen: input.shouldOpenUrls,
      });
      return null;
    }

    const structured = yield* promptStructuredInteraction(parsed);
    if (structured !== null) {
      return JSON.stringify({
        action: "accept",
        content: structured,
      });
    }

    const line = yield* promptLine(`${parsed.message} [y/N] `);
    const normalized = line.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }
    if (normalized !== "y" && normalized !== "yes" && normalized !== "n" && normalized !== "no") {
      return null;
    }
    const accepted = normalized === "y" || normalized === "yes";

    return JSON.stringify({
      action: accepted ? "accept" : "decline",
      content: {
        approve: accepted,
      },
    });
  });

const waitForExecutionProgress = (input: {
  client: ExecutorApiClient;
  workspaceId: ExecutionEnvelope["execution"]["workspaceId"];
  executionId: ExecutionEnvelope["execution"]["id"];
  pendingInteractionId: ExecutionInteraction["id"];
}) =>
  Effect.gen(function* () {
    while (true) {
      yield* sleep(SERVER_POLL_INTERVAL_MS);

      const next = yield* input.client.executions.get({
        path: {
          workspaceId: input.workspaceId,
          executionId: input.executionId,
        },
      });

      if (
        next.execution.status !== "waiting_for_interaction"
        || next.pendingInteraction === null
        || next.pendingInteraction.id !== input.pendingInteractionId
      ) {
        return next;
      }
    }
  });

const printExecution = (envelope: ExecutionEnvelope) =>
  Effect.sync(() => {
    const execution = envelope.execution;
    if (execution.status === "completed") {
      if (execution.resultJson) {
        console.log(execution.resultJson);
      } else {
        console.log("completed");
      }
      return;
    }

    if (execution.status === "failed") {
      console.error(execution.errorText ?? "Execution failed");
      process.exitCode = 1;
      return;
    }
    if (execution.status === "waiting_for_interaction" && envelope.pendingInteraction !== null) {
      return;
    }


    console.log(JSON.stringify({
      id: execution.id,
      status: execution.status,
    }));
  });

const seedDemoMcpSource = (input: {
  baseUrl: string;
  endpoint: string;
  name: string;
  namespace: string;
}) =>
  Effect.gen(function* () {
    yield* ensureServer(input.baseUrl);
    const { installation, client } = yield* getLocalAuthedClient(input.baseUrl);
    const result = yield* seedDemoMcpSourceInWorkspace({
      client,
      workspaceId: installation.workspaceId,
      endpoint: input.endpoint,
      name: input.name,
      namespace: input.namespace,
    });

    yield* Effect.sync(() => {
      console.log(JSON.stringify(result));
    });
  });

const seedGithubOpenApiSource = (input: {
  baseUrl: string;
  endpoint: string;
  specUrl: string;
  name: string;
  namespace: string;
  credentialEnvVar?: string;
}) =>
  Effect.gen(function* () {
    yield* ensureServer(input.baseUrl);
    const { installation, client } = yield* getLocalAuthedClient(input.baseUrl);
    const result = yield* seedGithubOpenApiSourceInWorkspace({
      client,
      workspaceId: installation.workspaceId,
      endpoint: input.endpoint,
      specUrl: input.specUrl,
      name: input.name,
      namespace: input.namespace,
      credentialEnvVar: input.credentialEnvVar,
    });

    yield* Effect.sync(() => {
      console.log(JSON.stringify(result));
    });
  });

const driveExecution = (input: {
  client: ExecutorApiClient;
  workspaceId: ExecutionEnvelope["execution"]["workspaceId"];
  envelope: ExecutionEnvelope;
  baseUrl: string;
  shouldOpenUrls: boolean;
}) =>
  Effect.gen(function* () {
    let current = input.envelope;

    while (current.execution.status === "waiting_for_interaction") {
      const pending = current.pendingInteraction;

      if (pending === null) {
        return current;
      }

      const parsed = parseInteractionPayload(pending);
      const handling = decideInteractionHandling({
        parsed,
        isInteractiveTerminal: process.stdin.isTTY && process.stdout.isTTY,
      });

      if (handling === "url_interactive" && parsed?.mode === "url") {
        yield* printUrlInteraction({
          message: parsed.message,
          url: parsed.url ?? null,
          shouldOpen: input.shouldOpenUrls,
        });

        current = yield* waitForExecutionProgress({
          client: input.client,
          workspaceId: input.workspaceId,
          executionId: current.execution.id,
          pendingInteractionId: pending.id,
        });
        continue;
      }

      if (handling === "url_paused") {
        if (input.shouldOpenUrls && parsed?.mode === "url" && parsed.url) {
          yield* openUrlInBrowser(parsed.url);
        }

        const paused = buildPausedExecutionOutput({
          executionId: current.execution.id,
          interaction: pending,
          baseUrl: input.baseUrl,
          shouldOpenUrls: input.shouldOpenUrls,
          cliName: CLI_NAME,
        });
        yield* Effect.sync(() => {
          console.log(JSON.stringify(paused));
          process.exitCode = 20;
        });
        return current;
      }

      if (handling === "form_paused") {
        const paused = buildPausedExecutionOutput({
          executionId: current.execution.id,
          interaction: pending,
          baseUrl: input.baseUrl,
          shouldOpenUrls: input.shouldOpenUrls,
          cliName: CLI_NAME,
        });
        yield* Effect.sync(() => {
          console.log(JSON.stringify(paused));
          process.exitCode = 20;
        });
        return current;
      }

      const responseJson = yield* promptInteraction({
        interaction: pending,
        shouldOpenUrls: input.shouldOpenUrls,
      });
      if (responseJson === null) {
        const paused = buildPausedExecutionOutput({
          executionId: current.execution.id,
          interaction: pending,
          baseUrl: input.baseUrl,
          shouldOpenUrls: input.shouldOpenUrls,
          cliName: CLI_NAME,
        });
        yield* Effect.sync(() => {
          console.log(JSON.stringify(paused));
          process.exitCode = 20;
        });
        return current;
      }

      current = yield* input.client.executions.resume({
        path: {
          workspaceId: input.workspaceId,
          executionId: current.execution.id,
        },
        payload: {
          responseJson,
          interactionMode: executionInteractionMode(),
        },
      });
    }

    return current;
  });

const serverStartCommand = Command.make(
  "start",
  {
    port: Options.integer("port").pipe(Options.withDefault(DEFAULT_SERVER_PORT)),
  },
  ({ port }) => runLocalExecutorServer(getDefaultServerOptions(port)),
).pipe(Command.withDescription("Start the local executor server"));

const serverCommand = Command.make("server").pipe(
  Command.withSubcommands([serverStartCommand] as const),
  Command.withDescription("Local server commands"),
);

const upCommand = Command.make(
  "up",
  {
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
  },
  ({ baseUrl }) =>
    ensureServer(baseUrl).pipe(
      Effect.zipRight(getServerStatus(baseUrl)),
      Effect.flatMap((status) => printText(renderStatus(status))),
    ),
).pipe(Command.withDescription("Ensure the local executor server is running"));

const downCommand = Command.make(
  "down",
  {
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
  },
  ({ baseUrl }) =>
    stopServer(baseUrl).pipe(
      Effect.flatMap((stopped) =>
        printText(stopped ? "Stopped local executor server." : "Local executor server is not running."),
      ),
    ),
).pipe(Command.withDescription("Stop the local executor server"));

const statusCommand = Command.make(
  "status",
  {
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
    json: Options.boolean("json").pipe(Options.withDefault(false)),
  },
  ({ baseUrl, json }) =>
    getServerStatus(baseUrl).pipe(
      Effect.flatMap((status) => json ? printJson(status) : printText(renderStatus(status))),
    ),
).pipe(Command.withDescription("Show local executor server status"));

const doctorCommand = Command.make(
  "doctor",
  {
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
    json: Options.boolean("json").pipe(Options.withDefault(false)),
  },
  ({ baseUrl, json }) =>
    getDoctorReport(baseUrl).pipe(
      Effect.flatMap((report) => json
        ? printJson(report)
        : printText([
            `ok: ${report.ok ? "yes" : "no"}`,
            ...Object.entries(report.checks).map(([name, check]) => `${name}: ${check.ok ? "ok" : "fail"} - ${check.detail}`),
          ].join("\n"))),
    ),
).pipe(Command.withDescription("Check local executor install and daemon health"));

const getDenoVersion = (): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configuredDenoExecutable = process.env.DENO_BIN?.trim();
    const bundledDenoExecutable = process.env.HOME?.trim()
      ? `${process.env.HOME.trim()}/.deno/bin/deno`
      : null;
    const bundledDenoExists = bundledDenoExecutable === null
      ? false
      : yield* fs.exists(bundledDenoExecutable).pipe(
          Effect.catchAll(() => Effect.succeed(false)),
        );
    const denoExecutable = configuredDenoExecutable
      || (bundledDenoExists ? bundledDenoExecutable : null)
      || "deno";

    return yield* Effect.tryPromise({
      try: () =>
        new Promise<string | null>((resolveVersion) => {
          const child = spawn(denoExecutable, ["--version"], {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
          });

          let stdout = "";
          child.stdout?.setEncoding("utf8");
          child.stdout?.on("data", (chunk: string) => {
            stdout += chunk;
          });

          child.once("error", () => resolveVersion(null));
          child.once("close", (code) => {
            if (code !== 0) {
              resolveVersion(null);
              return;
            }

            const match = /deno\s+(\S+)/i.exec(stdout);
            resolveVersion(match ? match[1] : null);
          });
        }),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

const sandboxCommand = Command.make(
  "sandbox",
  {},
  () =>
    Effect.gen(function* () {
      const version = yield* getDenoVersion();

      if (version !== null) {
        yield* printText(`Deno sandbox is ready (deno ${version}).`);
        return;
      }

      yield* printText(
        [
          "Deno is not installed.",
          "",
          "The executor sandbox requires Deno to run code in a secure, isolated subprocess.",
          "",
          "Install Deno:",
          "  curl -fsSL https://deno.land/install.sh | sh",
          "",
          "Or see: https://docs.deno.com/runtime/getting_started/installation/",
        ].join("\n"),
      );

      process.exitCode = 1;
    }),
).pipe(Command.withDescription("Check whether the Deno sandbox runtime is available"));


const callCommand = Command.make(
  "call",
  {
    code: Args.text({ name: "code" }).pipe(
      Args.withDescription("Inline code to execute."),
      Args.optional,
    ),
    file: Options.text("file").pipe(Options.optional),
    stdin: Options.boolean("stdin").pipe(Options.withDefault(false)),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
    noOpen: Options.boolean("no-open").pipe(Options.withDefault(false)),
  },
  ({ code, file, stdin, baseUrl, noOpen }) =>
    Effect.gen(function* () {
      const resolvedCode = yield* readCode({
        code: Option.getOrUndefined(code),
        file: Option.getOrUndefined(file),
        stdin,
      });

      yield* ensureServer(baseUrl);
      const { installation, client } = yield* getLocalAuthedClient(baseUrl);
      const created = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: resolvedCode,
          interactionMode: executionInteractionMode(),
        },
      });

      const settled = yield* driveExecution({
        client,
        workspaceId: installation.workspaceId,
        envelope: created,
        baseUrl,
        shouldOpenUrls: !noOpen,
      });

      yield* printExecution(settled);
    }),
).pipe(Command.withDescription("Execute code against the local executor server"));

const resumeCommand = Command.make(
  "resume",
  {
    executionId: Options.text("execution-id"),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
    noOpen: Options.boolean("no-open").pipe(Options.withDefault(false)),
  },
  ({ executionId, baseUrl, noOpen }) =>
    Effect.gen(function* () {
      yield* ensureServer(baseUrl);
      const { installation, client } = yield* getLocalAuthedClient(baseUrl);
      const decodedExecutionId = yield* decodeExecutionId(executionId).pipe(
        Effect.mapError((cause) => toError(cause)),
      );
      const execution = yield* client.executions.get({
        path: {
          workspaceId: installation.workspaceId,
          executionId: decodedExecutionId,
        },
      });

      const settled = yield* driveExecution({
        client,
        workspaceId: installation.workspaceId,
        envelope: execution,
        baseUrl,
        shouldOpenUrls: !noOpen,
      });

      yield* printExecution(settled);
    }),
).pipe(Command.withDescription("Resume a paused execution"));

const devSeedMcpDemoCommand = Command.make(
  "seed-mcp-demo",
  {
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
    endpoint: Options.text("endpoint").pipe(
      Options.withDefault("http://127.0.0.1:58506/mcp"),
    ),
    name: Options.text("name").pipe(Options.withDefault("Demo")),
    namespace: Options.text("namespace").pipe(Options.withDefault("demo")),
  },
  ({ baseUrl, endpoint, name, namespace }) =>
    seedDemoMcpSource({
      baseUrl,
      endpoint,
      name,
      namespace,
    }),
).pipe(
  Command.withDescription(
    "Seed the localhost MCP elicitation demo source into the default workspace",
  ),
);

const devSeedGithubCommand = Command.make(
  "seed-github",
  {
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
    endpoint: Options.text("endpoint").pipe(
      Options.withDefault("https://api.github.com"),
    ),
    specUrl: Options.text("spec-url").pipe(
      Options.withDefault(
        "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
      ),
    ),
    name: Options.text("name").pipe(Options.withDefault("GitHub")),
    namespace: Options.text("namespace").pipe(Options.withDefault("github")),
    credentialEnvVar: Options.text("credential-env-var").pipe(
      Options.withDefault("GITHUB_TOKEN"),
    ),
  },
  ({ baseUrl, endpoint, specUrl, name, namespace, credentialEnvVar }) =>
    seedGithubOpenApiSource({
      baseUrl,
      endpoint,
      specUrl,
      name,
      namespace,
      credentialEnvVar,
    }),
).pipe(
  Command.withDescription(
    "Seed a GitHub OpenAPI source into the default workspace",
  ),
);

const devCommand = Command.make("dev").pipe(
  Command.withSubcommands([devSeedMcpDemoCommand, devSeedGithubCommand] as const),
  Command.withDescription("Development helpers"),
);

const root = Command.make("executor").pipe(
  Command.withSubcommands([
    serverCommand,
    upCommand,
    downCommand,
    statusCommand,
    doctorCommand,
    sandboxCommand,
    callCommand,
    resumeCommand,
    devCommand,
  ] as const),
  Command.withDescription("Executor local CLI"),
);

const runCli = Command.run(root, {
  name: CLI_NAME,
  version: CLI_VERSION,
  executable: CLI_NAME,
});

const hiddenServer = (): Effect.Effect<void, Error, never> | null => {
  const args = getCliArgs();
  if (args[0] !== "__local-server") {
    return null;
  }

  const portFlagIndex = args.findIndex((arg) => arg === "--port");
  const port = portFlagIndex >= 0 ? Number(args[portFlagIndex + 1]) : DEFAULT_SERVER_PORT;

  return runLocalExecutorServer({
    ...getDefaultServerOptions(
      Number.isInteger(port) && port > 0 ? port : DEFAULT_SERVER_PORT,
    ),
  });
};

const program = (hiddenServer()
  ?? helpOverride()
  ?? runCli(toEffectCliArgv(getCliArgs())).pipe(Effect.mapError(toError)))
  .pipe(Effect.provide(NodeFileSystem.layer))
  .pipe(Effect.provide(NodePath.layer))
  .pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        console.error(Cause.pretty(cause));
        process.exitCode = 1;
      }),
    ),
  );

// Effect CLI's environment does not fully narrow at the process boundary.
NodeRuntime.runMain(program as Effect.Effect<void, never, never>);
