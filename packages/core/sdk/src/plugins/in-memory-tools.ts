import { Effect, JSONSchema, Schema } from "effect";

import type { SecretId } from "../ids";
import { ToolId } from "../ids";
import { ToolInvocationError } from "../errors";
import type { SecretRef } from "../secrets";
import {
  ToolInvocationResult,
  type ToolRegistration,
  type ToolInvoker,
  type InvokeOptions,
} from "../tools";
import {
  ElicitationDeclinedError,
  type ElicitationRequest,
} from "../elicitation";
import { definePlugin, type PluginContext } from "../plugin";
import { hoistDefinitions } from "../schema-refs";

// ---------------------------------------------------------------------------
// In-memory tool definition — typed via Schema
// ---------------------------------------------------------------------------

export interface MemoryToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Schema.Schema<TInput>;
  readonly outputSchema?: Schema.Schema<TOutput>;
  readonly handler: MemoryToolHandler<TInput>;
}

export type MemoryToolHandler<TInput> =
  | ((args: TInput) => unknown)
  | ((
      args: TInput,
      ctx: MemoryToolContext,
    ) => Effect.Effect<unknown, unknown>);

export interface MemoryToolContext {
  /** Request input from the user. Returns user data or fails if declined. */
  readonly elicit: (
    request: ElicitationRequest,
  ) => Effect.Effect<Record<string, unknown>, ElicitationDeclinedError>;

  /** Access to the SDK services */
  readonly sdk: MemoryToolSdkAccess;
}

/** SDK services available to in-memory tool handlers */
export interface MemoryToolSdkAccess {
  readonly secrets: {
    readonly list: () => Effect.Effect<readonly SecretRef[]>;
    readonly resolve: (secretId: SecretId) => Effect.Effect<string, unknown>;
    readonly status: (secretId: SecretId) => Effect.Effect<"resolved" | "missing">;
    readonly set: (input: {
      readonly id: SecretId;
      readonly name: string;
      readonly value: string;
      readonly purpose?: string;
    }) => Effect.Effect<SecretRef, unknown>;
    readonly remove: (secretId: SecretId) => Effect.Effect<boolean, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface InMemoryToolsPluginExtension {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly addTools: (
    tools: readonly MemoryToolDefinition<any, any>[],
  ) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Internal handler entry
// ---------------------------------------------------------------------------

interface HandlerEntry {
  readonly decode: (args: unknown) => unknown;
  readonly handler: MemoryToolHandler<unknown>;
  readonly isEffect: boolean;
}

// ---------------------------------------------------------------------------
// Registration builder — returns pure data + handler entry
// ---------------------------------------------------------------------------

const buildRegistration = (
  namespace: string,
  def: MemoryToolDefinition,
): { registration: ToolRegistration; entry: HandlerEntry; definitions: Record<string, unknown> } => {
  const id = ToolId.make(`${namespace}.${def.name}`);
  const decode = Schema.decodeUnknownSync(def.inputSchema);
  const isEffect = def.handler.length >= 2;

  const inputJson = JSONSchema.make(def.inputSchema);
  const outputJson = def.outputSchema ? JSONSchema.make(def.outputSchema) : undefined;

  const inputHoist = hoistDefinitions(inputJson);
  const outputHoist = hoistDefinitions(outputJson);

  const allDefs: Record<string, unknown> = {
    ...inputHoist.defs,
    ...outputHoist.defs,
  };

  const registration: ToolRegistration = {
    id,
    pluginKey: "inMemoryTools",
    sourceId: namespace,
    name: def.name,
    description: def.description,
    inputSchema: inputHoist.stripped,
    outputSchema: outputHoist.stripped,
    mayElicit: isEffect,
  };

  const entry: HandlerEntry = { decode, handler: def.handler as MemoryToolHandler<unknown>, isEffect };

  return { registration, entry, definitions: allDefs };
};

// ---------------------------------------------------------------------------
// Invoker — single function that handles all in-memory tools
// ---------------------------------------------------------------------------

const makeInvoker = (
  handlers: Map<string, HandlerEntry>,
  pluginCtx: PluginContext,
): ToolInvoker => ({
  invoke: (toolId: ToolId, args: unknown, options?: InvokeOptions) => {
    const entry = handlers.get(toolId);
    if (!entry) {
      return Effect.fail(
        new ToolInvocationError({
          toolId,
          message: `No handler registered for tool "${toolId}"`,
          cause: undefined,
        }),
      );
    }

    const parsed = Effect.try({
      try: () => entry.decode(args),
      catch: (err) =>
        new ToolInvocationError({
          toolId,
          message: `Invalid input: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        }),
    });

    if (!entry.isEffect) {
      return parsed.pipe(
        Effect.flatMap((input) =>
          Effect.try({
            try: () =>
              new ToolInvocationResult({
                data: (entry.handler as (args: unknown) => unknown)(input),
                error: null,
              }),
            catch: (err) =>
              new ToolInvocationError({
                toolId,
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              }),
          }),
        ),
      );
    }

    // Effect handler — build context with elicit + sdk access
    const ctx: MemoryToolContext = {
      sdk: {
        secrets: {
          list: () => pluginCtx.secrets.list(pluginCtx.scope.id),
          resolve: (secretId) => pluginCtx.secrets.resolve(secretId, pluginCtx.scope.id),
          status: (secretId) => pluginCtx.secrets.status(secretId, pluginCtx.scope.id),
          set: (input) =>
            pluginCtx.secrets.set({
              ...input,
              scopeId: pluginCtx.scope.id,
            }),
          remove: (secretId) => pluginCtx.secrets.remove(secretId),
        },
      },
      elicit: (request) =>
        Effect.gen(function* () {
          const handler = options?.onElicitation;
          if (!handler) {
            return yield* new ElicitationDeclinedError({
              toolId,
              action: "decline",
            });
          }
          const response = yield* handler({
            toolId,
            args,
            request,
          });
          if (response.action !== "accept") {
            return yield* new ElicitationDeclinedError({
              toolId,
              action: response.action as "decline" | "cancel",
            });
          }
          return response.content ?? {};
        }),
    };

    const effectHandler = entry.handler as (
      args: unknown,
      ctx: MemoryToolContext,
    ) => Effect.Effect<unknown, unknown>;

    return parsed.pipe(
      Effect.flatMap((input) => effectHandler(input, ctx)),
      Effect.map(
        (data) => new ToolInvocationResult({ data, error: null }),
      ),
      Effect.catchAll(
        (err): Effect.Effect<
          ToolInvocationResult,
          ToolInvocationError | ElicitationDeclinedError
        > => {
          if (
            err != null &&
            typeof err === "object" &&
            "_tag" in err &&
            (err as { _tag: string })._tag === "ElicitationDeclinedError"
          ) {
            return Effect.fail(err as ElicitationDeclinedError);
          }
          return Effect.fail(
            new ToolInvocationError({
              toolId,
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
          );
        },
      ),
    );
  },
});

// ---------------------------------------------------------------------------
// Tool definition helper — infers TInput from the schema
// ---------------------------------------------------------------------------

export function tool<TInput, TOutput>(
  def: MemoryToolDefinition<TInput, TOutput>,
): MemoryToolDefinition<TInput, TOutput> {
  return def;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inMemoryToolsPlugin = (config: {
  readonly namespace?: string;
  readonly tools: readonly MemoryToolDefinition<any, any>[];
}) => {
  const ns = config.namespace ?? "memory";
  return definePlugin<"inMemoryTools", InMemoryToolsPluginExtension>({
    key: "inMemoryTools",
    init: (ctx: PluginContext) =>
      Effect.gen(function* () {
        // Shared handler map for all tools in this plugin
        const handlers = new Map<string, HandlerEntry>();
        const invoker = makeInvoker(handlers, ctx);

        // Register the invoker once
        yield* ctx.tools.registerInvoker("inMemoryTools", invoker);

        // Build registrations + handler entries
        const results = config.tools.map((t) => buildRegistration(ns, t));

        // Register all definitions first
        const allDefs: Record<string, unknown> = {};
        for (const { definitions } of results) {
          Object.assign(allDefs, definitions);
        }
        yield* ctx.tools.registerDefinitions(allDefs);

        // Store handler entries + register tool data
        for (const { registration, entry } of results) {
          handlers.set(registration.id, entry);
        }
        const registrations = results.map(({ registration }) => registration);
        yield* ctx.tools.register(registrations);

        return {
          extension: {
            addTools: (newTools: readonly MemoryToolDefinition<any, any>[]) =>
              Effect.gen(function* () {
                const newResults = newTools.map((t) => buildRegistration(ns, t));

                const newDefs: Record<string, unknown> = {};
                for (const { definitions } of newResults) {
                  Object.assign(newDefs, definitions);
                }
                yield* ctx.tools.registerDefinitions(newDefs);

                for (const { registration, entry } of newResults) {
                  handlers.set(registration.id, entry);
                }
                const newRegistrations = newResults.map(({ registration }) => registration);
                yield* ctx.tools.register(newRegistrations);
              }),
          },
          close: () =>
            Effect.gen(function* () {
              yield* ctx.tools.unregister(registrations.map((r) => r.id));
              for (const { registration } of results) {
                handlers.delete(registration.id);
              }
            }),
        };
      }),
  });
};
