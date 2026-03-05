import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type {
  ElicitationRequest,
  ElicitationResponse,
  ExecutableTool,
  OnElicitation,
  OnToolInteraction,
  ToolDefinition,
  ToolDescriptor,
  ToolElicitationRequest,
  ToolInput,
  ToolInteractionDecision,
  ToolInteractionRequest,
  ToolInvocationContext,
  ToolInvoker,
  ToolMap,
  ToolMetadata,
  ToolPath,
} from "./types";

type ResolvedTool = {
  path: ToolPath;
  tool: ExecutableTool;
  metadata?: ToolMetadata;
};

const asToolPath = (value: string): ToolPath => value as ToolPath;

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const getSchemaValidator = (schema: unknown):
  | ((value: unknown, options?: StandardSchemaV1.Options) =>
    | StandardSchemaV1.Result<unknown>
    | Promise<StandardSchemaV1.Result<unknown>>)
  | null => {
  if (!schema || (typeof schema !== "object" && typeof schema !== "function")) {
    return null;
  }

  const standard = (schema as { "~standard"?: unknown })["~standard"];
  if (!standard || typeof standard !== "object") {
    return null;
  }

  const validate = (standard as { validate?: unknown }).validate;
  return typeof validate === "function"
    ? (validate as (
      value: unknown,
      options?: StandardSchemaV1.Options,
    ) =>
      | StandardSchemaV1.Result<unknown>
      | Promise<StandardSchemaV1.Result<unknown>>)
    : null;
};

const formatIssuePath = (
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | undefined,
): string => {
  if (!path || path.length === 0) {
    return "$";
  }

  return path
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
};

const formatIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  issues
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");

const parseInput = (input: {
  schema: unknown;
  value: unknown;
  path: string;
}): Effect.Effect<unknown, Error> => {
  const validate = getSchemaValidator(input.schema);
  if (!validate) {
    return Effect.fail(
      new Error(`Tool ${input.path} has no Standard Schema validator on inputSchema`),
    );
  }

  return Effect.tryPromise({
    try: () => Promise.resolve(validate(input.value)),
    catch: toError,
  }).pipe(
    Effect.flatMap((result) => {
      if ("issues" in result && result.issues) {
        return Effect.fail(
          new Error(
            `Input validation failed for ${input.path}: ${formatIssues(result.issues)}`,
          ),
        );
      }
      return Effect.succeed(result.value);
    }),
  );
};

const defaultRequiredElicitation = (path: string): ElicitationRequest => ({
  mode: "form",
  message: `Approval required before invoking ${path}`,
  requestedSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
});

const executeDecision: ToolInteractionDecision = { kind: "execute" };

const toElicitationDecision = (input: {
  metadata?: ToolMetadata;
  path: string;
}): ToolInteractionDecision | null => {
  if (input.metadata?.elicitation) {
    return {
      kind: "elicit",
      elicitation: input.metadata.elicitation,
    };
  }

  if (input.metadata?.interaction === "required") {
    return {
      kind: "elicit",
      elicitation: defaultRequiredElicitation(input.path),
    };
  }

  return null;
};

const defaultInteractionDecision = (input: {
  metadata?: ToolMetadata;
  path: string;
}): ToolInteractionDecision =>
  toElicitationDecision(input) ?? executeDecision;

export class ToolInteractionPendingError extends Data.TaggedError(
  "ToolInteractionPendingError",
)<{
  readonly path: string;
  readonly elicitation: ElicitationRequest;
  readonly interactionId?: string;
}> {}

export class ToolInteractionDeniedError extends Data.TaggedError(
  "ToolInteractionDeniedError",
)<{
  readonly path: string;
  readonly reason: string;
}> {}

export const allowAllToolInteractions: OnToolInteraction = () =>
  Effect.succeed(executeDecision);

const evaluateInteractionDecision = (input: {
  path: ToolPath;
  args: unknown;
  metadata?: ToolMetadata;
  sourceKey: string;
  context?: ToolInvocationContext;
  onToolInteraction?: OnToolInteraction;
}): Effect.Effect<ToolInteractionDecision, unknown> => {
  const defaultDecision = defaultInteractionDecision({
    metadata: input.metadata,
    path: input.path,
  });

  if (!input.onToolInteraction) {
    return Effect.succeed(defaultDecision);
  }

  const request: ToolInteractionRequest = {
    path: input.path,
    sourceKey: input.sourceKey,
    args: input.args,
    metadata: input.metadata,
    context: input.context,
    defaultElicitation:
      defaultDecision.kind === "elicit"
        ? defaultDecision.elicitation
        : null,
  };

  return input.onToolInteraction(request);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergeAcceptedElicitationContent = (input: {
  path: ToolPath;
  args: unknown;
  response: ElicitationResponse;
  inputSchema: unknown;
}): Effect.Effect<unknown, Error> => {
  if (!input.response.content) {
    return Effect.succeed(input.args);
  }

  if (!isRecord(input.args)) {
    return Effect.fail(
      new Error(
        `Tool ${input.path} cannot merge elicitation content into non-object arguments`,
      ),
    );
  }

  const merged = {
    ...input.args,
    ...input.response.content,
  };

  return parseInput({
    schema: input.inputSchema,
    value: merged,
    path: input.path,
  });
};

const declineReasonFromResponse = (input: {
  path: ToolPath;
  response: ElicitationResponse;
}): string => {
  const reason =
    input.response.content
    && typeof input.response.content.reason === "string"
    && input.response.content.reason.trim().length > 0
      ? input.response.content.reason.trim()
      : null;

  if (reason) {
    return reason;
  }

  return input.response.action === "cancel"
    ? `Interaction cancelled for ${input.path}`
    : `Interaction declined for ${input.path}`;
};

const resolveInteractionDecision = (input: {
  path: ToolPath;
  args: unknown;
  inputSchema: unknown;
  metadata?: ToolMetadata;
  sourceKey: string;
  context?: ToolInvocationContext;
  decision: ToolInteractionDecision;
  interactionId: string;
  onElicitation?: OnElicitation;
}): Effect.Effect<unknown, ToolInteractionPendingError | ToolInteractionDeniedError | Error> => {
  if (input.decision.kind === "execute") {
    return Effect.succeed(input.args);
  }

  if (input.decision.kind === "decline") {
    return Effect.fail(
      new ToolInteractionDeniedError({
        path: input.path,
        reason: input.decision.reason,
      }),
    );
  }

  if (!input.onElicitation) {
    return Effect.fail(
      new ToolInteractionPendingError({
        path: input.path,
        elicitation: input.decision.elicitation,
        interactionId: input.interactionId,
      }),
    );
  }

  const elicitationRequest: ToolElicitationRequest = {
    interactionId: input.interactionId,
    path: input.path,
    sourceKey: input.sourceKey,
    args: input.args,
    metadata: input.metadata,
    context: input.context,
    elicitation: input.decision.elicitation,
  };

  return input.onElicitation(elicitationRequest).pipe(
    Effect.mapError(toError),
    Effect.flatMap((response) => {
      if (response.action !== "accept") {
        return Effect.fail(
          new ToolInteractionDeniedError({
            path: input.path,
            reason: declineReasonFromResponse({
              path: input.path,
              response,
            }),
          }),
        );
      }

      return mergeAcceptedElicitationContent({
        path: input.path,
        args: input.args,
        response,
        inputSchema: input.inputSchema,
      });
    }),
  );
};

export function wrapTool(input: {
  tool: ExecutableTool;
  metadata?: ToolMetadata;
}): ToolDefinition {
  return {
    tool: input.tool,
    metadata: input.metadata,
  };
}

export const toTool = wrapTool;
export const toExecutorTool = wrapTool;

const isToolDefinition = (value: ToolInput): value is ToolDefinition =>
  typeof value === "object" && value !== null && "tool" in value;

const stringifySchema = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const inferHintFromSchemaJson = (
  schemaJson: string | undefined,
  fallback: string,
): string => {
  if (!schemaJson) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(schemaJson) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    if (title.length > 0) {
      return title;
    }

    if (parsed.type === "object") {
      const properties =
        parsed.properties
          && typeof parsed.properties === "object"
          && !Array.isArray(parsed.properties)
          ? Object.keys(parsed.properties as Record<string, unknown>)
          : [];
      if (properties.length > 0) {
        const shown = properties.slice(0, 3).join(", ");
        return properties.length <= 3
          ? `object { ${shown} }`
          : `object { ${shown}, ... }`;
      }
      return "object";
    }

    if (parsed.type === "array") {
      return "array";
    }

    if (typeof parsed.type === "string") {
      return parsed.type;
    }
  } catch {
    // Ignore malformed schema and fall back.
  }

  return fallback;
};

export function createToolsFromRecord(input: {
  tools: Record<string, ExecutableTool>;
  sourceKey?: string;
}): ToolMap {
  const { tools, sourceKey = "in_memory.tools" } = input;

  return Object.fromEntries(
    Object.entries(tools)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, tool]) => [
        path,
        wrapTool({
          tool,
          metadata: { sourceKey },
        }),
      ]),
  ) as ToolMap;
}

const resolveToolsFromMap = (input: {
  tools: ToolMap;
  sourceKey?: string;
}): ResolvedTool[] => {
  const defaultSourceKey = input.sourceKey ?? "in_memory.tools";

  return Object.entries(input.tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) => {
      const entry = isToolDefinition(value) ? value : { tool: value };
      const metadata = entry.metadata
        ? {
            sourceKey: defaultSourceKey,
            ...entry.metadata,
          }
        : { sourceKey: defaultSourceKey };

      return {
        path: asToolPath(path),
        tool: entry.tool,
        metadata,
      } satisfies ResolvedTool;
    });
};

export function toolDescriptorsFromTools(input: {
  tools: ToolMap;
  sourceKey?: string;
}): ToolDescriptor[] {
  const resolvedTools = resolveToolsFromMap({
    tools: input.tools,
    sourceKey: input.sourceKey,
  });

  return resolvedTools.map((entry) => {
    const metadata = entry.metadata;
    const definition = entry.tool;
    const inputSchemaJson =
      metadata?.inputSchemaJson
      ?? stringifySchema(definition.inputSchema)
      ?? stringifySchema(definition.parameters);
    const outputSchemaJson =
      metadata?.outputSchemaJson
      ?? stringifySchema(definition.outputSchema);

    return {
      path: entry.path,
      sourceKey: metadata?.sourceKey ?? "in_memory.tools",
      description: definition.description,
      interaction: metadata?.interaction,
      elicitation: metadata?.elicitation,
      inputHint:
        metadata?.inputHint ?? inferHintFromSchemaJson(inputSchemaJson, "input"),
      outputHint:
        metadata?.outputHint ?? inferHintFromSchemaJson(outputSchemaJson, "output"),
      inputSchemaJson,
      outputSchemaJson,
      refHintKeys: metadata?.refHintKeys,
    } satisfies ToolDescriptor;
  });
}

const asInteractionIdPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]/g, "_");

const createInteractionIdFactory = () => {
  let sequence = 0;

  return (input: { path: ToolPath; context?: ToolInvocationContext }): string => {
    sequence += 1;

    const runId =
      typeof input.context?.runId === "string" && input.context.runId.length > 0
        ? input.context.runId
        : "run";
    const callId =
      typeof input.context?.callId === "string" && input.context.callId.length > 0
        ? input.context.callId
        : `call_${String(sequence)}`;

    return `${asInteractionIdPart(runId)}:${asInteractionIdPart(callId)}:${asInteractionIdPart(String(input.path))}:${String(sequence)}`;
  };
};

export const makeToolInvokerFromTools = (input: {
  tools: ToolMap;
  sourceKey?: string;
  onToolInteraction?: OnToolInteraction;
  onElicitation?: OnElicitation;
}): ToolInvoker => {
  const resolvedTools = resolveToolsFromMap({
    tools: input.tools,
    sourceKey: input.sourceKey,
  });
  const byPath = new Map(resolvedTools.map((entry) => [entry.path as string, entry]));
  const nextInteractionId = createInteractionIdFactory();

  return {
    invoke: ({ path, args, context }) =>
      Effect.gen(function* () {
        const entry = byPath.get(path);
        if (!entry) {
          return yield* Effect.fail(new Error(`Unknown tool path: ${path}`));
        }

        const parsedInput = yield* parseInput({
          schema: entry.tool.inputSchema,
          value: args,
          path,
        });

        const decision = yield* evaluateInteractionDecision({
          path: entry.path,
          args: parsedInput,
          metadata: entry.metadata,
          sourceKey: entry.metadata?.sourceKey ?? "in_memory.tools",
          context,
          onToolInteraction: input.onToolInteraction,
        });

        const interactionId =
          decision.kind === "elicit" && decision.interactionId
            ? decision.interactionId
            : nextInteractionId({ path: entry.path, context });

        const executableInput = yield* resolveInteractionDecision({
          path: entry.path,
          args: parsedInput,
          inputSchema: entry.tool.inputSchema,
          metadata: entry.metadata,
          sourceKey: entry.metadata?.sourceKey ?? "in_memory.tools",
          context,
          decision,
          interactionId,
          onElicitation: input.onElicitation,
        });

        return yield* Effect.tryPromise({
          try: () => Promise.resolve(entry.tool.execute(executableInput)),
          catch: toError,
        });
      }),
  };
};
