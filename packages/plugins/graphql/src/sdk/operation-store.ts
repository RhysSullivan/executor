import type { Effect } from "effect";
import type { ToolId } from "@executor/sdk";

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
  /** Pre-resolved runtime invocation config (endpoint, headers). */
  readonly invocationConfig: InvocationConfig;
}

export interface GraphqlOperationStore {
  readonly get: (
    toolId: ToolId,
  ) => Effect.Effect<{ binding: OperationBinding; namespace: string } | null>;

  readonly put: (
    toolId: ToolId,
    namespace: string,
    binding: OperationBinding,
  ) => Effect.Effect<void>;

  readonly remove: (toolId: ToolId) => Effect.Effect<void>;

  readonly listByNamespace: (namespace: string) => Effect.Effect<readonly ToolId[]>;

  readonly removeByNamespace: (namespace: string) => Effect.Effect<readonly ToolId[]>;

  readonly putSource: (source: StoredSource) => Effect.Effect<void>;

  readonly removeSource: (namespace: string) => Effect.Effect<void>;

  readonly listSources: () => Effect.Effect<readonly StoredSource[]>;

  readonly getSource: (namespace: string) => Effect.Effect<StoredSource | null>;

  readonly getSourceConfig: (namespace: string) => Effect.Effect<SourceConfig | null>;
}
