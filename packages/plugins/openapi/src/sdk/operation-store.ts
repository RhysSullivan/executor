import type { Effect } from "effect";
import type { ToolId } from "@executor/core";

import type { OperationBinding, InvocationConfig, HeaderValue } from "./types";

// ---------------------------------------------------------------------------
// Operation store — plugin's own storage for invocation data
// ---------------------------------------------------------------------------

export interface SourceConfig {
  readonly spec: string;
  readonly baseUrl?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, HeaderValue>;
}

export interface StoredSource {
  readonly namespace: string;
  readonly name: string;
  readonly config: SourceConfig;
}

export interface StoredOperation {
  readonly toolId: ToolId;
  readonly namespace: string;
  readonly binding: OperationBinding;
  readonly config: InvocationConfig;
}

export interface OpenApiOperationStore {
  readonly get: (
    toolId: ToolId,
  ) => Effect.Effect<{ binding: OperationBinding; config: InvocationConfig } | null>;

  readonly put: (entries: readonly StoredOperation[]) => Effect.Effect<void>;

  readonly remove: (toolId: ToolId) => Effect.Effect<void>;

  readonly listByNamespace: (namespace: string) => Effect.Effect<readonly ToolId[]>;

  readonly removeByNamespace: (namespace: string) => Effect.Effect<readonly ToolId[]>;

  readonly putSource: (source: StoredSource) => Effect.Effect<void>;

  readonly removeSource: (namespace: string) => Effect.Effect<void>;

  readonly listSources: () => Effect.Effect<readonly StoredSource[]>;
}
