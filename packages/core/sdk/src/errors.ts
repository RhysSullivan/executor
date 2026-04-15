import { Data, Schema } from "effect";

import { ToolId, SecretId } from "./ids";

// ---------------------------------------------------------------------------
// Tool lifecycle
// ---------------------------------------------------------------------------

export class ToolNotFoundError extends Schema.TaggedError<ToolNotFoundError>()(
  "ToolNotFoundError",
  { toolId: ToolId },
) {}

export class ToolInvocationError extends Data.TaggedError("ToolInvocationError")<{
  readonly toolId: ToolId;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Tool row exists in the DB but its owning plugin isn't loaded. Means
 *  the tool was registered by a plugin that's no longer present in the
 *  current executor config — usually a stale row from an older session. */
export class PluginNotLoadedError extends Schema.TaggedError<PluginNotLoadedError>()(
  "PluginNotLoadedError",
  {
    pluginId: Schema.String,
    toolId: ToolId,
  },
) {}

/** Tool was found but its owning plugin has no `invokeTool` handler —
 *  the plugin only declares static tools and this one's id matched
 *  dynamically somehow. Shouldn't happen in practice; guards against
 *  programmer error. */
export class NoHandlerError extends Schema.TaggedError<NoHandlerError>()(
  "NoHandlerError",
  {
    toolId: ToolId,
    pluginId: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Source lifecycle
// ---------------------------------------------------------------------------

export class SourceNotFoundError extends Schema.TaggedError<SourceNotFoundError>()(
  "SourceNotFoundError",
  { sourceId: Schema.String },
) {}

/** `executor.sources.remove(id)` was called on a source with
 *  `canRemove: false` — typically a static source declared by a plugin
 *  at startup. Removing static sources is a bug in the caller. */
export class SourceRemovalNotAllowedError extends Schema.TaggedError<SourceRemovalNotAllowedError>()(
  "SourceRemovalNotAllowedError",
  { sourceId: Schema.String },
) {}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export class SecretNotFoundError extends Schema.TaggedError<SecretNotFoundError>()(
  "SecretNotFoundError",
  { secretId: SecretId },
) {}

export class SecretResolutionError extends Schema.TaggedError<SecretResolutionError>()(
  "SecretResolutionError",
  {
    secretId: SecretId,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Union type for convenience in signatures.
// ---------------------------------------------------------------------------

export type ExecutorError =
  | ToolNotFoundError
  | ToolInvocationError
  | PluginNotLoadedError
  | NoHandlerError
  | SourceNotFoundError
  | SourceRemovalNotAllowedError
  | SecretNotFoundError
  | SecretResolutionError;
