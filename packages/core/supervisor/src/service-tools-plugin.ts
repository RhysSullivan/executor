import { Effect, JSONSchema, Layer, Schema } from "effect";
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

import { PlatformSupervisor } from "./platform-supervisor.js";
import { DEFAULT_SERVICE_PORT, type ServiceSpec } from "./service-spec.js";

/**
 * Configuration for the generic service-management runtime tool plugin.
 * All defaults are optional — each active backend resolves label/unit-file
 * paths from its own conventions when the field is omitted.
 */
export interface ServiceToolsPluginConfig {
  readonly defaultLabel?: string;
  readonly defaultUnitFilePath?: string;
  readonly defaultLogPath?: string;
  readonly defaultPort?: number;
  /** Human-readable name shown in the extension metadata. */
  readonly displayName?: string;
  /** Backend identifier (e.g. `"launchd"`, `"systemd"`). */
  readonly backendKind?: string;
}

export interface ServiceToolsExtension {
  readonly displayName: string;
  readonly backendKind: string;
  readonly defaultLabel?: string;
  readonly defaultUnitFilePath?: string;
  readonly defaultLogPath?: string;
  readonly defaultPort: number;
}

const PLUGIN_KEY = "service" as const;
const RUNTIME_SOURCE_ID = "built-in";

const InstallInputSchema = Schema.Struct({
  port: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
});
const EmptyInputSchema = Schema.Struct({});

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "_tag" in err && typeof err._tag === "string") {
    return err._tag;
  }
  return String(err);
};

const inputSchema = <TInput>(schema: Schema.Schema<TInput, TInput, never>): unknown =>
  JSONSchema.make(schema);

const approval = (description: string): ToolAnnotations =>
  new ToolAnnotations({
    requiresApproval: true,
    approvalDescription: description,
  });

interface BuildHandlerArgs<TInput> {
  readonly toolId: ToolId;
  readonly inputSchema: Schema.Schema<TInput, TInput, never>;
  readonly effect: (input: TInput) => Effect.Effect<unknown, unknown, PlatformSupervisor>;
  readonly annotations?: ToolAnnotations;
  readonly layer: Layer.Layer<PlatformSupervisor>;
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
        Effect.flatMap((input) => args.effect(input as TInput).pipe(Effect.provide(args.layer))),
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

/**
 * Build a runtime tool plugin that exposes the five service lifecycle
 * operations (`service.install`, `service.uninstall`, `service.start`,
 * `service.stop`, `service.status`) to the executor's MCP/tool surface,
 * backed by the supplied {@link PlatformSupervisor} layer.
 *
 * Callers on unsupported platforms should simply omit this plugin from the
 * executor's plugin tuple so the tools don't appear in the tool list at all.
 */
export const makeServiceToolsPlugin = (
  layer: Layer.Layer<PlatformSupervisor>,
  config?: ServiceToolsPluginConfig,
): ExecutorPlugin<typeof PLUGIN_KEY, ServiceToolsExtension> => {
  const defaults: Required<
    Pick<ServiceToolsPluginConfig, "defaultPort" | "displayName" | "backendKind">
  > & {
    readonly defaultLabel?: string;
    readonly defaultUnitFilePath?: string;
    readonly defaultLogPath?: string;
  } = {
    defaultPort: config?.defaultPort ?? DEFAULT_SERVICE_PORT,
    displayName: config?.displayName ?? "System service",
    backendKind: config?.backendKind ?? "platform",
    defaultLabel: config?.defaultLabel,
    defaultUnitFilePath: config?.defaultUnitFilePath,
    defaultLogPath: config?.defaultLogPath,
  };

  const baseSpec: ServiceSpec = {
    label: defaults.defaultLabel,
    unitFilePath: defaults.defaultUnitFilePath,
    logPath: defaults.defaultLogPath,
    port: defaults.defaultPort,
  };

  return definePlugin({
    key: PLUGIN_KEY,
    init: (ctx: PluginContext) =>
      Effect.gen(function* () {
        const statusId = ToolId.make("service.status");
        const installId = ToolId.make("service.install");
        const uninstallId = ToolId.make("service.uninstall");
        const startId = ToolId.make("service.start");
        const stopId = ToolId.make("service.stop");

        const registrations: readonly ToolRegistration[] = [
          {
            id: statusId,
            pluginKey: PLUGIN_KEY,
            sourceId: RUNTIME_SOURCE_ID,
            name: "service.status",
            description: "Show the status of the executor daemon service",
            inputSchema: inputSchema(EmptyInputSchema),
          },
          {
            id: installId,
            pluginKey: PLUGIN_KEY,
            sourceId: RUNTIME_SOURCE_ID,
            name: "service.install",
            description: "Install the executor daemon as a system service",
            mayElicit: true,
            inputSchema: inputSchema(InstallInputSchema),
          },
          {
            id: uninstallId,
            pluginKey: PLUGIN_KEY,
            sourceId: RUNTIME_SOURCE_ID,
            name: "service.uninstall",
            description: "Uninstall the executor daemon service",
            mayElicit: true,
            inputSchema: inputSchema(EmptyInputSchema),
          },
          {
            id: startId,
            pluginKey: PLUGIN_KEY,
            sourceId: RUNTIME_SOURCE_ID,
            name: "service.start",
            description: "(Re)load the executor daemon service",
            mayElicit: true,
            inputSchema: inputSchema(EmptyInputSchema),
          },
          {
            id: stopId,
            pluginKey: PLUGIN_KEY,
            sourceId: RUNTIME_SOURCE_ID,
            name: "service.stop",
            description: "Stop the executor daemon service",
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
            layer,
            effect: () =>
              Effect.gen(function* () {
                const supervisor = yield* PlatformSupervisor;
                return yield* supervisor.status(baseSpec);
              }),
          }),
        );

        yield* ctx.tools.registerRuntimeHandler(
          installId,
          buildHandler({
            toolId: installId,
            inputSchema: InstallInputSchema,
            layer,
            annotations: approval(`Install executor daemon as a ${defaults.displayName}`),
            effect: (input) =>
              Effect.gen(function* () {
                const supervisor = yield* PlatformSupervisor;
                return yield* supervisor.install({
                  ...baseSpec,
                  port: input.port ?? baseSpec.port,
                  scope: input.scope,
                });
              }),
          }),
        );

        yield* ctx.tools.registerRuntimeHandler(
          uninstallId,
          buildHandler({
            toolId: uninstallId,
            inputSchema: EmptyInputSchema,
            layer,
            annotations: approval("Uninstall the executor daemon service"),
            effect: () =>
              Effect.gen(function* () {
                const supervisor = yield* PlatformSupervisor;
                return yield* supervisor.uninstall(baseSpec);
              }),
          }),
        );

        yield* ctx.tools.registerRuntimeHandler(
          startId,
          buildHandler({
            toolId: startId,
            inputSchema: EmptyInputSchema,
            layer,
            annotations: approval("(Re)load the executor daemon service"),
            effect: () =>
              Effect.gen(function* () {
                const supervisor = yield* PlatformSupervisor;
                return yield* supervisor.start(baseSpec);
              }),
          }),
        );

        yield* ctx.tools.registerRuntimeHandler(
          stopId,
          buildHandler({
            toolId: stopId,
            inputSchema: EmptyInputSchema,
            layer,
            annotations: approval("Stop the executor daemon service"),
            effect: () =>
              Effect.gen(function* () {
                const supervisor = yield* PlatformSupervisor;
                return yield* supervisor.stop(baseSpec);
              }),
          }),
        );

        return {
          extension: {
            displayName: defaults.displayName,
            backendKind: defaults.backendKind,
            defaultLabel: defaults.defaultLabel,
            defaultUnitFilePath: defaults.defaultUnitFilePath,
            defaultLogPath: defaults.defaultLogPath,
            defaultPort: defaults.defaultPort,
          },
          close: () =>
            ctx.tools.unregisterRuntime([statusId, installId, uninstallId, startId, stopId]),
        };
      }),
  });
};
