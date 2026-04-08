import type { Effect } from "effect";
import type { ToolId } from "@executor/core";

import type { OperationBinding, InvocationConfig, HeaderValue } from "./types";

// ---------------------------------------------------------------------------
// Operation store — plugin's own storage for invocation data
// ---------------------------------------------------------------------------

export interface SourceConfig {
  readonly endpoint: string;
  readonly introspectionJson?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, HeaderValue>;
}

export interface StoredSource {
  readonly namespace: string;
  readonly name: string;
  readonly config: SourceConfig;
}

export interface GraphqlOperationStore {
  readonly get: (
    toolId: ToolId,
  ) => Effect.Effect<{ binding: OperationBinding; config: InvocationConfig } | null>;

  readonly put: (
    toolId: ToolId,
    namespace: string,
    binding: OperationBinding,
    config: InvocationConfig,
  ) => Effect.Effect<void>;

  readonly remove: (toolId: ToolId) => Effect.Effect<void>;

  readonly listByNamespace: (namespace: string) => Effect.Effect<readonly ToolId[]>;

  readonly removeByNamespace: (namespace: string) => Effect.Effect<readonly ToolId[]>;

  readonly putSource: (source: StoredSource) => Effect.Effect<void>;

  readonly removeSource: (namespace: string) => Effect.Effect<void>;

  readonly listSources: () => Effect.Effect<readonly StoredSource[]>;
}
