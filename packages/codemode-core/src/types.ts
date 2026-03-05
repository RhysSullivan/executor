import type { StandardSchemaV1 } from "@standard-schema/spec";
import type * as Effect from "effect/Effect";

export type ToolPath = string & { readonly __toolPath: unique symbol };

export type StandardSchema<Input = unknown, Output = unknown> =
  StandardSchemaV1<Input, Output>;

export type ElicitationFormRequest = {
  mode?: "form";
  message: string;
  requestedSchema: Record<string, unknown>;
};

export type ElicitationUrlRequest = {
  mode: "url";
  message: string;
  url: string;
  elicitationId: string;
};

export type ElicitationRequest =
  | ElicitationFormRequest
  | ElicitationUrlRequest;

export type ElicitationAction = "accept" | "decline" | "cancel";

export type ElicitationResponse = {
  action: ElicitationAction;
  content?: Record<string, unknown>;
};

export type ToolInvocationContext = {
  runId?: string;
  callId?: string;
  scope?: string;
  actor?: string;
  [key: string]: unknown;
};

export type ToolInteractionRequest = {
  path: ToolPath;
  sourceKey: string;
  args: unknown;
  metadata?: ToolMetadata;
  context?: ToolInvocationContext;
  defaultElicitation: ElicitationRequest | null;
};

export type ToolInteractionDecision =
  | { kind: "execute" }
  | { kind: "decline"; reason: string }
  | {
      kind: "elicit";
      elicitation: ElicitationRequest;
      interactionId?: string;
    };

export type ToolElicitationRequest = {
  interactionId: string;
  path: ToolPath;
  sourceKey: string;
  args: unknown;
  metadata?: ToolMetadata;
  context?: ToolInvocationContext;
  elicitation: ElicitationRequest;
};

export type OnToolInteraction = (
  input: ToolInteractionRequest,
) => Effect.Effect<ToolInteractionDecision, unknown>;

export type OnElicitation = (
  input: ToolElicitationRequest,
) => Effect.Effect<ElicitationResponse, unknown>;

export type ToolMetadata = {
  interaction?: "auto" | "required";
  elicitation?: ElicitationRequest;
  inputHint?: string;
  outputHint?: string;
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  refHintKeys?: readonly string[];
  sourceKey?: string;
};

export type ExecutableTool = {
  description?: string;
  inputSchema: StandardSchema;
  outputSchema?: StandardSchema;
  parameters?: StandardSchema;
  execute: (...args: any[]) => unknown;
};

export const unknownInputSchema: StandardSchema = {
  "~standard": {
    version: 1,
    vendor: "@executor-v3/codemode-core",
    validate: (value: unknown) => ({
      value,
    }),
  },
};


export type ToolDefinition = {
  tool: ExecutableTool;
  metadata?: ToolMetadata;
};

export type ToolInput = ExecutableTool | ToolDefinition;

export type ToolMap = Record<string, ToolInput>;

export type ToolDescriptor = {
  path: ToolPath;
  sourceKey: string;
  description?: string;
  interaction?: "auto" | "required";
  elicitation?: ElicitationRequest;
  inputHint?: string;
  outputHint?: string;
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  refHintKeys?: readonly string[];
};

export type SearchHit = {
  path: ToolPath;
  score: number;
};

export interface SearchProvider {
  search(input: {
    query: string;
    limit: number;
  }): Effect.Effect<readonly SearchHit[], unknown>;
}

export interface ToolDirectory {
  listNamespaces(input: {
    limit: number;
  }): Effect.Effect<readonly { namespace: string; toolCount: number }[], unknown>;

  listTools(input: {
    namespace?: string;
    query?: string;
    limit: number;
  }): Effect.Effect<readonly { path: ToolPath }[], unknown>;

  getByPath(input: {
    path: ToolPath;
    includeSchemas: boolean;
  }): Effect.Effect<ToolDescriptor | null, unknown>;

  getByPaths(input: {
    paths: readonly ToolPath[];
    includeSchemas: boolean;
  }): Effect.Effect<readonly ToolDescriptor[], unknown>;
}

export type CatalogPrimitive = {
  namespaces(input: {
    limit?: number;
  }): Effect.Effect<
    { namespaces: readonly { namespace: string; toolCount: number }[] },
    unknown
  >;
  tools(input: {
    namespace?: string;
    query?: string;
    limit?: number;
  }): Effect.Effect<{ results: readonly { path: ToolPath }[] }, unknown>;
};

export type DescribePrimitive = {
  tool(input: {
    path: ToolPath;
    includeSchemas?: boolean;
  }): Effect.Effect<ToolDescriptor | null, unknown>;
};

export type DiscoverPrimitive = {
  run(input: {
    query: string;
    limit?: number;
    includeSchemas?: boolean;
  }): Effect.Effect<
    {
      bestPath: ToolPath | null;
      results: readonly (Record<string, unknown> & {
        path: ToolPath;
        score: number;
      })[];
      total: number;
    },
    unknown
  >;
};

export type DiscoveryPrimitives = {
  catalog?: CatalogPrimitive;
  describe?: DescribePrimitive;
  discover?: DiscoverPrimitive;
};

export type ExecuteResult = {
  result: unknown;
  error?: string;
  logs?: string[];
};

export type ToolInvocationInput = {
  path: string;
  args: unknown;
  context?: ToolInvocationContext;
};

export interface ToolInvoker {
  invoke(input: ToolInvocationInput): Effect.Effect<unknown, unknown>;
}

export interface CodeExecutor {
  execute(
    code: string,
    toolInvoker: ToolInvoker,
  ): Effect.Effect<ExecuteResult, unknown>;
}

export type CodeToolOutput = {
  code: string;
  result: unknown;
  logs?: string[];
};
