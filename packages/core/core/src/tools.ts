import { Context, Effect, Schema } from "effect";

import { ToolId } from "./ids";
import { ToolNotFoundError, ToolInvocationError } from "./errors";
import type {
  ElicitationHandler,
  ElicitationDeclinedError,
} from "./elicitation";

// ---------------------------------------------------------------------------
// Tool models
// ---------------------------------------------------------------------------

export class ToolAnnotations extends Schema.Class<ToolAnnotations>("ToolAnnotations")({
  /** Whether this tool requires user approval before execution */
  requiresApproval: Schema.optional(Schema.Boolean),
  /** Human-readable description shown in the approval prompt */
  approvalDescription: Schema.optional(Schema.String),
}) {}

export class ToolMetadata extends Schema.Class<ToolMetadata>("ToolMetadata")({
  id: ToolId,
  pluginKey: Schema.String,
  /** Source this tool belongs to (namespace identifier) */
  sourceId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** Whether this tool may request elicitation during invocation */
  mayElicit: Schema.optional(Schema.Boolean),
}) {}

export class ToolSchema extends Schema.Class<ToolSchema>("ToolSchema")({
  id: ToolId,
  inputTypeScript: Schema.optional(Schema.String),
  outputTypeScript: Schema.optional(Schema.String),
  typeScriptDefinitions: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
}) {}

export class ToolInvocationResult extends Schema.Class<ToolInvocationResult>(
  "ToolInvocationResult",
)({
  data: Schema.Unknown,
  error: Schema.NullOr(Schema.Unknown),
  status: Schema.optional(Schema.Number),
}) {}

// ---------------------------------------------------------------------------
// ToolListFilter
// ---------------------------------------------------------------------------

export class ToolListFilter extends Schema.Class<ToolListFilter>("ToolListFilter")({
  /** Filter to tools belonging to a specific source */
  sourceId: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Invocation options
// ---------------------------------------------------------------------------

export interface InvokeOptions {
  /** Handler for elicitation requests, or "accept-all" to auto-approve everything. */
  readonly onElicitation: ElicitationHandler | "accept-all";
}

// ---------------------------------------------------------------------------
// ToolRegistry — stores and invokes tools
// ---------------------------------------------------------------------------

export class ToolRegistry extends Context.Tag("@executor/sdk/ToolRegistry")<
  ToolRegistry,
  {
    readonly list: (filter?: ToolListFilter) => Effect.Effect<readonly ToolMetadata[]>;

    readonly schema: (
      toolId: ToolId,
    ) => Effect.Effect<ToolSchema, ToolNotFoundError>;

    readonly invoke: (
      toolId: ToolId,
      args: unknown,
      options: InvokeOptions,
    ) => Effect.Effect<
      ToolInvocationResult,
      ToolNotFoundError | ToolInvocationError | ElicitationDeclinedError
    >;

    /**
     * Shared schema definitions across all tools.
     * `$ref` pointers in tool schemas resolve against this store.
     */
    readonly definitions: () => Effect.Effect<Record<string, unknown>>;

    /**
     * Register named schema definitions into the shared store.
     * Plugins call this before registering tools whose schemas use `$ref`.
     */
    readonly registerDefinitions: (
      defs: Record<string, unknown>,
    ) => Effect.Effect<void>;

    /**
     * Register named schema definitions for runtime tools. These remain
     * runtime-only and are not persisted by storage-backed registries.
     */
    readonly registerRuntimeDefinitions: (
      defs: Record<string, unknown>,
    ) => Effect.Effect<void>;

    /** Remove named schema definitions that were registered for runtime tools. */
    readonly unregisterRuntimeDefinitions: (
      names: readonly string[],
    ) => Effect.Effect<void>;

    /**
     * Register a plugin invoker. Must be called before registering tools
     * with the corresponding pluginKey.
     */
    readonly registerInvoker: (
      pluginKey: string,
      invoker: ToolInvoker,
    ) => Effect.Effect<void>;

    /**
     * Resolve annotations for a tool by delegating to the plugin's invoker.
     */
    readonly resolveAnnotations: (
      toolId: ToolId,
    ) => Effect.Effect<ToolAnnotations | undefined>;

    /** Register tools (used by plugins to push tools into the registry) */
    readonly register: (
      tools: readonly ToolRegistration[],
    ) => Effect.Effect<void>;

    /**
     * Register runtime-only tools. These should behave like normal tools for
     * listing, schema lookup, discovery, and invocation, but are not persisted.
     */
    readonly registerRuntime: (
      tools: readonly ToolRegistration[],
    ) => Effect.Effect<void>;

    /** Register a runtime-only handler for a specific tool id. */
    readonly registerRuntimeHandler: (
      toolId: ToolId,
      handler: RuntimeToolHandler,
    ) => Effect.Effect<void>;

    /** Unregister runtime-only tools by id without touching persisted storage. */
    readonly unregisterRuntime: (
      toolIds: readonly ToolId[],
    ) => Effect.Effect<void>;

    /** Unregister tools by id (used by plugins on cleanup) */
    readonly unregister: (
      toolIds: readonly ToolId[],
    ) => Effect.Effect<void>;

    /** Unregister all tools belonging to a source */
    readonly unregisterBySource: (
      sourceId: string,
    ) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// ToolInvoker — plugin-provided invocation handler
// ---------------------------------------------------------------------------

export interface ToolInvoker {
  readonly invoke: (
    toolId: ToolId,
    args: unknown,
    options: InvokeOptions,
  ) => Effect.Effect<
    ToolInvocationResult,
    ToolInvocationError | ElicitationDeclinedError
  >;

  /** Dynamically compute annotations for a tool (e.g. approval requirements). */
  readonly resolveAnnotations?: (
    toolId: ToolId,
  ) => Effect.Effect<ToolAnnotations | undefined>;
}

export interface RuntimeToolHandler {
  readonly invoke: (
    args: unknown,
    options: InvokeOptions,
  ) => Effect.Effect<
    ToolInvocationResult,
    ToolInvocationError | ElicitationDeclinedError
  >;

  readonly resolveAnnotations?: () => Effect.Effect<ToolAnnotations | undefined>;
}

// ---------------------------------------------------------------------------
// ToolRegistration — pure data, no closures
// ---------------------------------------------------------------------------

export class ToolRegistration extends Schema.Class<ToolRegistration>(
  "ToolRegistration",
)({
  id: ToolId,
  pluginKey: Schema.String,
  /** Source this tool belongs to (namespace identifier) */
  sourceId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mayElicit: Schema.optional(Schema.Boolean),
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
}) {}
