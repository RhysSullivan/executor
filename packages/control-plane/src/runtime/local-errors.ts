import * as Data from "effect/Data";

export const unknownLocalErrorDetails = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class LocalFileSystemError extends Data.TaggedError(
  "LocalFileSystemError",
)<{
  readonly message: string;
  readonly action: string;
  readonly path: string;
  readonly details: string;
}> {}

export class LocalExecutorConfigDecodeError extends Data.TaggedError(
  "LocalExecutorConfigDecodeError",
)<{
  readonly message: string;
  readonly path: string;
  readonly details: string;
}> {}

export class LocalWorkspaceStateDecodeError extends Data.TaggedError(
  "LocalWorkspaceStateDecodeError",
)<{
  readonly message: string;
  readonly path: string;
  readonly details: string;
}> {}

export class LocalSourceArtifactDecodeError extends Data.TaggedError(
  "LocalSourceArtifactDecodeError",
)<{
  readonly message: string;
  readonly path: string;
  readonly details: string;
}> {}

export class LocalToolTranspileError extends Data.TaggedError(
  "LocalToolTranspileError",
)<{
  readonly message: string;
  readonly path: string;
  readonly details: string;
}> {}

export class LocalToolImportError extends Data.TaggedError(
  "LocalToolImportError",
)<{
  readonly message: string;
  readonly path: string;
  readonly details: string;
}> {}

export class LocalToolDefinitionError extends Data.TaggedError(
  "LocalToolDefinitionError",
)<{
  readonly message: string;
  readonly path: string;
  readonly details: string;
}> {}

export class LocalToolPathConflictError extends Data.TaggedError(
  "LocalToolPathConflictError",
)<{
  readonly message: string;
  readonly path: string;
  readonly otherPath: string;
  readonly toolPath: string;
}> {}

export class RuntimeLocalWorkspaceUnavailableError extends Data.TaggedError(
  "RuntimeLocalWorkspaceUnavailableError",
)<{
  readonly message: string;
}> {}

export class RuntimeLocalWorkspaceMismatchError extends Data.TaggedError(
  "RuntimeLocalWorkspaceMismatchError",
)<{
  readonly message: string;
  readonly requestedWorkspaceId: string;
  readonly activeWorkspaceId: string;
}> {}

export class LocalConfiguredSourceNotFoundError extends Data.TaggedError(
  "LocalConfiguredSourceNotFoundError",
)<{
  readonly message: string;
  readonly sourceId: string;
}> {}

export class LocalSourceArtifactMissingError extends Data.TaggedError(
  "LocalSourceArtifactMissingError",
)<{
  readonly message: string;
  readonly sourceId: string;
}> {}

export class LocalUnsupportedSourceKindError extends Data.TaggedError(
  "LocalUnsupportedSourceKindError",
)<{
  readonly message: string;
  readonly kind: string;
}> {}
