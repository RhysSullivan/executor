import { Data, Schema } from "effect";

import { ConnectionId, ToolId, SecretId } from "./ids";

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

/** Raised when `secrets.remove(id)` is called on a secret whose row has
 *  `owned_by_connection_id` set. The connection owns the lifecycle —
 *  callers must go through `connections.remove(connectionId)` to
 *  delete it along with its siblings. */
export class SecretOwnedByConnectionError extends Schema.TaggedError<SecretOwnedByConnectionError>()(
  "SecretOwnedByConnectionError",
  {
    secretId: SecretId,
    connectionId: ConnectionId,
  },
) {}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export class ConnectionNotFoundError extends Schema.TaggedError<ConnectionNotFoundError>()(
  "ConnectionNotFoundError",
  { connectionId: ConnectionId },
) {}

export class ConnectionProviderNotRegisteredError extends Schema.TaggedError<ConnectionProviderNotRegisteredError>()(
  "ConnectionProviderNotRegisteredError",
  {
    provider: Schema.String,
    connectionId: Schema.optional(ConnectionId),
  },
) {}

export class ConnectionRefreshNotSupportedError extends Schema.TaggedError<ConnectionRefreshNotSupportedError>()(
  "ConnectionRefreshNotSupportedError",
  {
    connectionId: ConnectionId,
    provider: Schema.String,
  },
) {}

/**
 * Raised by `connections.accessToken(id)` when the provider's refresh
 * handler reported that the stored refresh token is permanently
 * invalid (RFC 6749 §5.2 `invalid_grant` and friends). The caller —
 * typically a tool invocation — surfaces this so the UI can prompt the
 * user to sign in again. Distinct from `ConnectionRefreshError` so
 * "the network flaked, retry later" and "the grant is dead, re-auth"
 * don't collapse into one error tag at the plugin boundary.
 */
export class ConnectionReauthRequiredError extends Schema.TaggedError<ConnectionReauthRequiredError>()(
  "ConnectionReauthRequiredError",
  {
    connectionId: ConnectionId,
    provider: Schema.String,
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
  | SecretResolutionError
  | SecretOwnedByConnectionError
  | ConnectionNotFoundError
  | ConnectionProviderNotRegisteredError
  | ConnectionRefreshNotSupportedError
  | ConnectionReauthRequiredError;
