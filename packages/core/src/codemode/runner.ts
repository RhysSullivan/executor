import { Effect } from "effect";

export type ToolKind = "read" | "write";
export type ToolApprovalMode = "auto" | "required";
export type ApprovalDecision = "approved" | "denied";
export type ToolReceiptDecision = "auto" | ApprovalDecision;
export type ToolReceiptStatus = "succeeded" | "failed" | "denied";

export interface ToolCallReceipt {
  callId: string;
  toolPath: string;
  kind: ToolKind;
  approval: ToolApprovalMode;
  decision: ToolReceiptDecision;
  status: ToolReceiptStatus;
  timestamp: string;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
}

export interface ApprovalRequest {
  callId: string;
  toolPath: string;
  kind: ToolKind;
  approval: ToolApprovalMode;
  input: unknown;
  inputPreview?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly _tag: "ToolDefinition";
  readonly kind: ToolKind;
  readonly approval: ToolApprovalMode;
  readonly run: (input: TInput) => Effect.Effect<TOutput, unknown>;
  readonly previewInput?: (input: TInput) => string | undefined;
  readonly previewOutput?: (output: TOutput) => string | undefined;
}

export type ToolTree = {
  readonly [name: string]: ToolTree | ToolDefinition<any, any>;
};

export interface CodeModeRunnerOptions {
  tools: ToolTree;
  requestApproval: (request: ApprovalRequest) => Effect.Effect<ApprovalDecision, unknown>;
  now?: () => Date;
  newCallId?: () => string;
}

export interface RunCodeOptions {
  code: string;
}

export type CodeModeRunResult =
  | {
      ok: true;
      value: unknown;
      receipts: ToolCallReceipt[];
    }
  | {
      ok: false;
      error: string;
      receipts: ToolCallReceipt[];
    };

const MAX_PREVIEW_CHARS = 180;
const AsyncFunctionCtor = Object.getPrototypeOf(
  async (_tools: unknown) => undefined,
).constructor as new (argName: string, body: string) => (tools: unknown) => Promise<unknown>;

export function defineTool<TInput, TOutput>(definition: {
  kind: ToolKind;
  approval: ToolApprovalMode;
  run: (input: TInput) => Effect.Effect<TOutput, unknown>;
  previewInput?: (input: TInput) => string | undefined;
  previewOutput?: (output: TOutput) => string | undefined;
}): ToolDefinition<TInput, TOutput> {
  return {
    _tag: "ToolDefinition",
    ...definition,
  };
}

export function createCodeModeRunner(options: CodeModeRunnerOptions): {
  run: (params: RunCodeOptions) => Effect.Effect<CodeModeRunResult, never>;
} {
  const now = options.now ?? (() => new Date());
  const newCallId = options.newCallId ?? defaultCallId;

  return {
    run: (params) => {
      const receipts: ToolCallReceipt[] = [];
      const tools = materializeToolTree({
        tools: options.tools,
        requestApproval: options.requestApproval,
        newCallId,
        now,
        receipts,
      });

      return Effect.tryPromise({
        try: async () => {
          const execute = new AsyncFunctionCtor("tools", `"use strict";\n${params.code}`);
          const value = await execute(tools);
          return {
            ok: true as const,
            value,
            receipts: [...receipts],
          };
        },
        catch: (cause) => ({
          ok: false as const,
          error: describeUnknown(cause),
          receipts: [...receipts],
        }),
      }).pipe(
        Effect.catchAll((result) =>
          Effect.succeed({
            ok: false as const,
            error: result.error,
            receipts: result.receipts,
          }),
        ),
      );
    },
  };
}

function materializeToolTree(params: {
  tools: ToolTree;
  requestApproval: (request: ApprovalRequest) => Effect.Effect<ApprovalDecision, unknown>;
  newCallId: () => string;
  now: () => Date;
  receipts: ToolCallReceipt[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(params.tools)) {
    const toolPath = name;
    out[name] = materializeToolNode({
      node,
      toolPath,
      requestApproval: params.requestApproval,
      newCallId: params.newCallId,
      now: params.now,
      receipts: params.receipts,
    });
  }
  return out;
}

function materializeToolNode(params: {
  node: ToolTree | ToolDefinition<any, any>;
  toolPath: string;
  requestApproval: (request: ApprovalRequest) => Effect.Effect<ApprovalDecision, unknown>;
  newCallId: () => string;
  now: () => Date;
  receipts: ToolCallReceipt[];
}): unknown {
  if (isToolDefinition(params.node)) {
    return createToolInvoker({
      definition: params.node,
      toolPath: params.toolPath,
      requestApproval: params.requestApproval,
      newCallId: params.newCallId,
      now: params.now,
      receipts: params.receipts,
    });
  }

  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(params.node)) {
    out[name] = materializeToolNode({
      node: child,
      toolPath: `${params.toolPath}.${name}`,
      requestApproval: params.requestApproval,
      newCallId: params.newCallId,
      now: params.now,
      receipts: params.receipts,
    });
  }
  return out;
}

function createToolInvoker(params: {
  definition: ToolDefinition<any, any>;
  toolPath: string;
  requestApproval: (request: ApprovalRequest) => Effect.Effect<ApprovalDecision, unknown>;
  newCallId: () => string;
  now: () => Date;
  receipts: ToolCallReceipt[];
}): (input: unknown) => Promise<unknown> {
  return async (input: unknown) => {
    const callId = params.newCallId();
    const timestamp = params.now().toISOString();
    const inputPreview = previewValue(input, params.definition.previewInput);

    let decision: ToolReceiptDecision = "auto";
    if (params.definition.approval === "required") {
      const approval = await Effect.runPromise(
        params.requestApproval({
          callId,
          toolPath: params.toolPath,
          kind: params.definition.kind,
          approval: params.definition.approval,
          input,
          ...(inputPreview !== undefined ? { inputPreview } : {}),
        }),
      );
      decision = approval;
      if (approval === "denied") {
        params.receipts.push({
          callId,
          toolPath: params.toolPath,
          kind: params.definition.kind,
          approval: params.definition.approval,
          decision,
          status: "denied",
          timestamp,
          ...(inputPreview !== undefined ? { inputPreview } : {}),
        });
        throw new Error(`Tool call denied: ${params.toolPath}`);
      }
    }

    const execution = await Effect.runPromiseExit(params.definition.run(input));
    if (execution._tag === "Success") {
      const value = execution.value;
      const outputPreview = previewValue(value, params.definition.previewOutput);
      params.receipts.push({
        callId,
        toolPath: params.toolPath,
        kind: params.definition.kind,
        approval: params.definition.approval,
        decision,
        status: "succeeded",
        timestamp,
        ...(inputPreview !== undefined ? { inputPreview } : {}),
        ...(outputPreview !== undefined ? { outputPreview } : {}),
      });
      return value;
    }

    const error = describeUnknown(execution.cause);
    params.receipts.push({
      callId,
      toolPath: params.toolPath,
      kind: params.definition.kind,
      approval: params.definition.approval,
      decision,
      status: "failed",
      timestamp,
      ...(inputPreview !== undefined ? { inputPreview } : {}),
      error,
    });
    throw new Error(error);
  };
}

function isToolDefinition(value: unknown): value is ToolDefinition<any, any> {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value as { _tag?: unknown })._tag === "ToolDefinition"
  );
}

function previewValue<T>(
  value: T,
  customPreview: ((value: T) => string | undefined) | undefined,
): string | undefined {
  if (customPreview) {
    return truncatePreview(customPreview(value));
  }
  if (value === undefined) {
    return undefined;
  }
  return truncatePreview(safeStringify(value));
}

function truncatePreview(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length <= MAX_PREVIEW_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_PREVIEW_CHARS)}...`;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function defaultCallId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function describeUnknown(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  return safeStringify(cause);
}
