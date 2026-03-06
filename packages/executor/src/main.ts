import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { Command, Options } from "@effect/cli";
import {
  NodeFileSystem,
  NodePath,
  NodeRuntime,
} from "@effect/platform-node";
import {
  ExecutionIdSchema,
  makeControlPlaneClient,
  type ControlPlaneClient,
  type ExecutionEnvelope,
  type ExecutionInteraction,
} from "@executor-v3/control-plane";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import {
  DEFAULT_SERVER_BASE_URL,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  SERVER_POLL_INTERVAL_MS,
  SERVER_START_TIMEOUT_MS,
} from "./config";
import { seedDemoMcpSourceInWorkspace } from "./dev";
import { runLocalExecutorServer } from "./server";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

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

const readCode = (input: {
  code?: string;
  file?: string;
}): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    if (input.code && input.code.trim().length > 0) {
      return input.code;
    }

    if (input.file && input.file.trim().length > 0) {
      const contents = yield* Effect.tryPromise({
        try: () => readFile(input.file!, "utf8"),
        catch: toError,
      });
      if (contents.trim().length > 0) {
        return contents;
      }
    }

    return yield* Effect.fail(new Error("Provide --code or --file."));
  });

const getBootstrapClient = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  makeControlPlaneClient({ baseUrl });

const decodeExecutionId = Schema.decodeUnknown(ExecutionIdSchema);

const getLocalAuthedClient = (baseUrl: string = DEFAULT_SERVER_BASE_URL) =>
  Effect.gen(function* () {
    const bootstrapClient = yield* getBootstrapClient(baseUrl);
    const installation = yield* bootstrapClient.local.installation({});
    const client = yield* makeControlPlaneClient({
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

const startServerInBackground = (port: number) =>
  Effect.sync(() => {
    const script = process.argv[1];
    if (!script) {
      throw new Error("Cannot determine current executor entrypoint.");
    }

    const child = spawn(process.execPath, [script, "__local-server", "--port", String(port)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
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

    const startedAt = Date.now();
    while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
      const ready = yield* isServerReachable(baseUrl);
      if (ready) {
        return;
      }
      yield* sleep(SERVER_POLL_INTERVAL_MS);
    }

    return yield* Effect.fail(
      new Error(`Timed out waiting for local executor server at ${baseUrl}`),
    );
  });

const parseInteractionPayload = (interaction: ExecutionInteraction): {
  message: string;
  mode: "form" | "url";
  url?: string;
} | null => {
  try {
    const parsed = JSON.parse(interaction.payloadJson) as {
      elicitation?: {
        message?: string;
        mode?: "form" | "url";
        url?: string;
      };
    };

    if (!parsed.elicitation || typeof parsed.elicitation.message !== "string") {
      return null;
    }

    return {
      message: parsed.elicitation.message,
      mode: parsed.elicitation.mode === "url" ? "url" : "form",
      url: parsed.elicitation.url,
    };
  } catch {
    return null;
  }
};

const promptInteraction = (interaction: ExecutionInteraction) =>
  Effect.gen(function* () {
    const parsed = parseInteractionPayload(interaction);

    if (!process.stdin.isTTY || !process.stdout.isTTY || parsed === null) {
      return null;
    }

    if (parsed.mode === "url") {
      yield* Effect.sync(() => {
        process.stdout.write(`${parsed.message}\n${parsed.url ?? ""}\n`);
      });
      yield* promptLine("Press enter when done. ");
      return JSON.stringify({ action: "accept" });
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

const driveExecution = (input: {
  client: ControlPlaneClient;
  workspaceId: ExecutionEnvelope["execution"]["workspaceId"];
  envelope: ExecutionEnvelope;
}) =>
  Effect.gen(function* () {
    let current = input.envelope;

    while (current.execution.status === "waiting_for_interaction") {
      const pending = current.pendingInteraction;

      if (pending === null) {
        return current;
      }

      const responseJson = yield* promptInteraction(pending);
      if (responseJson === null) {
        yield* Effect.sync(() => {
          console.log(JSON.stringify({
            id: current.execution.id,
            status: current.execution.status,
            interactionId: pending.id,
            message: parseInteractionPayload(pending)?.message ?? "Interaction required",
            resumeCommand: `executor resume --execution-id ${current.execution.id}`,
          }));
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
  ({ port }) => runLocalExecutorServer({ host: DEFAULT_SERVER_HOST, port }),
).pipe(Command.withDescription("Start the local executor server"));

const serverCommand = Command.make("server").pipe(
  Command.withSubcommands([serverStartCommand] as any),
  Command.withDescription("Local server commands"),
);

const runCommand = Command.make(
  "run",
  {
    code: Options.text("code").pipe(Options.optional),
    file: Options.text("file").pipe(Options.optional),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
  },
  ({ code, file, baseUrl }) =>
    Effect.gen(function* () {
      const resolvedCode = yield* readCode({
        code: Option.getOrUndefined(code),
        file: Option.getOrUndefined(file),
      });

      yield* ensureServer(baseUrl);
      const { installation, client } = yield* getLocalAuthedClient(baseUrl);
      const created = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: resolvedCode,
        },
      });

      const settled = yield* driveExecution({
        client,
        workspaceId: installation.workspaceId,
        envelope: created,
      });

      yield* printExecution(settled);
    }),
).pipe(Command.withDescription("Execute code against the local executor server"));

const resumeCommand = Command.make(
  "resume",
  {
    executionId: Options.text("execution-id"),
    baseUrl: Options.text("base-url").pipe(Options.withDefault(DEFAULT_SERVER_BASE_URL)),
  },
  ({ executionId, baseUrl }) =>
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

const devCommand = Command.make("dev").pipe(
  Command.withSubcommands([devSeedMcpDemoCommand] as any),
  Command.withDescription("Development helpers"),
);

const root = Command.make("executor").pipe(
  Command.withSubcommands([serverCommand, runCommand, resumeCommand, devCommand] as any),
  Command.withDescription("Executor local CLI"),
);

const runCli = Command.run(root, {
  name: "executor",
  version: "0.1.0",
});

const hiddenServer = (): Effect.Effect<void, Error, never> | null => {
  if (process.argv[2] !== "__local-server") {
    return null;
  }

  const portFlagIndex = process.argv.findIndex((arg) => arg === "--port");
  const port = portFlagIndex >= 0 ? Number(process.argv[portFlagIndex + 1]) : DEFAULT_SERVER_PORT;

  return runLocalExecutorServer({
    host: DEFAULT_SERVER_HOST,
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_SERVER_PORT,
  });
};

const program = (hiddenServer()
  ?? runCli(process.argv).pipe(Effect.mapError(toError)))
  .pipe(Effect.provide(NodeFileSystem.layer))
  .pipe(Effect.provide(NodePath.layer));

// Effect CLI's environment does not fully narrow at the process boundary.
NodeRuntime.runMain(program as Effect.Effect<void, Error, never>);
