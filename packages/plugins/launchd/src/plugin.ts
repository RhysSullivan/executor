import { Effect, JSONSchema, Schema } from "effect";
import {
  ToolAnnotations,
  ToolId,
  ToolInvocationError,
  ToolInvocationResult,
  definePlugin,
  type ExecutorPlugin,
  type PluginContext,
  type RuntimeToolHandler,
  type ToolRegistration,
} from "@executor/sdk";

import { installAgent, printAgent, startAgent, stopAgent, uninstallAgent } from "./supervisor.js";
import {
  DEFAULT_EXECUTOR_LAUNCHD_LABEL,
  getDefaultExecutorLogPath,
  getDefaultLaunchAgentPath,
} from "./plist.js";

export interface LaunchdPluginConfig {
  readonly label?: string;
  readonly plistPath?: string;
  readonly logPath?: string;
  readonly defaultPort?: number;
}

export interface LaunchdExtension {
  readonly displayName: string;
  readonly isSupported: boolean;
  readonly label: string;
  readonly plistPath: string;
  readonly logPath: string;
}

const InstallInputSchema = Schema.Struct({
  port: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
});

const EmptyInputSchema = Schema.Struct({});

const PLUGIN_KEY = "launchd" as const;
const RUNTIME_SOURCE_ID = "built-in";

const resolveConfig = (config?: LaunchdPluginConfig) => {
  const label = config?.label ?? DEFAULT_EXECUTOR_LAUNCHD_LABEL;
  return {
    label,
    plistPath: config?.plistPath ?? getDefaultLaunchAgentPath(label),
    logPath: config?.logPath ?? getDefaultExecutorLogPath(),
    defaultPort: config?.defaultPort ?? 4788,
  };
};

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "_tag" in err && typeof err._tag === "string") {
    return err._tag;
  }
  return String(err);
};

interface BuildHandlerArgs<TInput> {
  readonly toolId: ToolId;
  readonly inputSchema: Schema.Schema<TInput, TInput, never>;
  readonly effect: (input: TInput) => Effect.Effect<unknown, unknown>;
  readonly annotations?: ToolAnnotations;
}

const buildHandler = <TInput>(args: BuildHandlerArgs<TInput>): RuntimeToolHandler => {
  const decode = Schema.decodeUnknownSync(args.inputSchema);

  return {
    invoke: (rawArgs) =>
      Effect.try({
        try: () => decode(rawArgs),
        catch: (err) =>
          new ToolInvocationError({
            toolId: args.toolId,
            message: `Invalid input: ${errorMessage(err)}`,
            cause: err,
          }),
      }).pipe(
        Effect.flatMap((input) => args.effect(input as TInput)),
        Effect.map((data) => new ToolInvocationResult({ data, error: null })),
        Effect.mapError((err) =>
          err instanceof ToolInvocationError
            ? err
            : new ToolInvocationError({
                toolId: args.toolId,
                message: errorMessage(err),
                cause: err,
              }),
        ),
      ),
    resolveAnnotations: args.annotations ? () => Effect.succeed(args.annotations) : undefined,
  };
};

const inputSchema = <TInput>(schema: Schema.Schema<TInput, TInput, never>): unknown =>
  JSONSchema.make(schema);

const approval = (description: string): ToolAnnotations =>
  new ToolAnnotations({
    requiresApproval: true,
    approvalDescription: description,
  });

export const launchdPlugin = (
  config?: LaunchdPluginConfig,
): ExecutorPlugin<typeof PLUGIN_KEY, LaunchdExtension> =>
  definePlugin({
    key: PLUGIN_KEY,
    init: (ctx: PluginContext) =>
      Effect.gen(function* () {
        const cfg = resolveConfig(config);

        const statusId = ToolId.make("launchd.status");
        const installId = ToolId.make("launchd.install");
        const uninstallId = ToolId.make("launchd.uninstall");
        const startId = ToolId.make("launchd.start");
        const stopId = ToolId.make("launchd.stop");

        const registrations: readonly ToolRegistration[] = [
          {
            id: statusId,
            pluginKey: PLUGIN_KEY,
            sourceId: RUNTIME_SOURCE_ID,
            name: "launchd.status",
            description: "Show the status of the executor macOS LaunchAgent",
            inputSchema: inputSchema(EmptyInputSchema),
          },
          {
            id: installId,
            pluginKey: PLUGIN_KEY,
            sourceId: RUNTIME_SOURCE_ID,
            name: "launchd.install",
            description: "Install the executor daemon as a macOS LaunchAgent",
            mayElicit: true,
            inputSchema: inputSchema(InstallInputSchema),
          },
          {
            id: uninstallId,
            pluginKey: PLUGIN_KEY,
            sourceId: RUNTIME_SOURCE_ID,
            name: "launchd.uninstall",
            description: "Uninstall the executor LaunchAgent",
            mayElicit: true,
            inputSchema: inputSchema(EmptyInputSchema),
          },
          {
            id: startId,
            pluginKey: PLUGIN_KEY,
            sourceId: RUNTIME_SOURCE_ID,
            name: "launchd.start",
            description: "(Re)load the executor LaunchAgent",
            mayElicit: true,
            inputSchema: inputSchema(EmptyInputSchema),
          },
          {
            id: stopId,
            pluginKey: PLUGIN_KEY,
            sourceId: RUNTIME_SOURCE_ID,
            name: "launchd.stop",
            description: "Unload the executor LaunchAgent",
            mayElicit: true,
            inputSchema: inputSchema(EmptyInputSchema),
          },
        ];

        yield* ctx.tools.registerRuntime(registrations);

        yield* ctx.tools.registerRuntimeHandler(
          statusId,
          buildHandler({
            toolId: statusId,
            inputSchema: EmptyInputSchema,
            effect: () =>
              printAgent({
                label: cfg.label,
                plistPath: cfg.plistPath,
                logPath: cfg.logPath,
                port: cfg.defaultPort,
              }),
          }),
        );

        yield* ctx.tools.registerRuntimeHandler(
          installId,
          buildHandler({
            toolId: installId,
            inputSchema: InstallInputSchema,
            effect: (input) =>
              installAgent({
                label: cfg.label,
                plistPath: cfg.plistPath,
                logPath: cfg.logPath,
                port: input.port ?? cfg.defaultPort,
                scope: input.scope,
              }),
            annotations: approval("Install executor daemon as a macOS LaunchAgent"),
          }),
        );

        yield* ctx.tools.registerRuntimeHandler(
          uninstallId,
          buildHandler({
            toolId: uninstallId,
            inputSchema: EmptyInputSchema,
            effect: () =>
              uninstallAgent({
                label: cfg.label,
                plistPath: cfg.plistPath,
              }),
            annotations: approval("Uninstall the executor LaunchAgent"),
          }),
        );

        yield* ctx.tools.registerRuntimeHandler(
          startId,
          buildHandler({
            toolId: startId,
            inputSchema: EmptyInputSchema,
            effect: () =>
              startAgent({
                label: cfg.label,
                plistPath: cfg.plistPath,
                port: cfg.defaultPort,
              }),
            annotations: approval("(Re)load the executor LaunchAgent"),
          }),
        );

        yield* ctx.tools.registerRuntimeHandler(
          stopId,
          buildHandler({
            toolId: stopId,
            inputSchema: EmptyInputSchema,
            effect: () =>
              stopAgent({
                label: cfg.label,
                plistPath: cfg.plistPath,
              }),
            annotations: approval("Stop the executor LaunchAgent"),
          }),
        );

        return {
          extension: {
            displayName: "macOS launchd",
            isSupported: process.platform === "darwin",
            label: cfg.label,
            plistPath: cfg.plistPath,
            logPath: cfg.logPath,
          },
          close: () =>
            ctx.tools.unregisterRuntime([statusId, installId, uninstallId, startId, stopId]),
        };
      }),
  });
