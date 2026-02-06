/**
 * Tool definition system.
 *
 * Tools are the capabilities exposed to LLM-generated code in the sandbox.
 * They can come from hand-written plugins, MCP servers, or OpenAPI specs —
 * all produce the same ToolTree + TypeScript declarations.
 */

import type { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalMode = "auto" | "required";

export type ApprovalDecision = "approved" | "denied";

export type ReceiptDecision = "auto" | ApprovalDecision;

export type ReceiptStatus = "succeeded" | "failed" | "denied";

/**
 * Presentation data for rendering an approval request in any client.
 */
export interface ApprovalPresentation {
  title: string;
  details?: string;
  link?: string;
}

/**
 * Immutable record of a single tool invocation.
 */
export interface ToolCallReceipt {
  readonly callId: string;
  readonly toolPath: string;
  readonly approval: ApprovalMode;
  readonly decision: ReceiptDecision;
  readonly status: ReceiptStatus;
  readonly timestamp: number;
  readonly inputPreview: string;
  readonly outputPreview?: string;
  readonly error?: string;
}

/**
 * Request sent to the approval callback for "required" tools.
 */
export interface ApprovalRequest {
  readonly callId: string;
  readonly toolPath: string;
  readonly input: unknown;
  readonly preview: ApprovalPresentation;
}

/**
 * A single tool definition. The public API for tool authors.
 *
 * - `args` and `returns` are Zod schemas used for:
 *    - Input validation at invocation time
 *    - TypeScript declaration generation for the typechecker
 *    - LLM prompt guidance generation
 *
 * - `run` is a plain async function (Effect is an internal detail)
 *
 * - `formatApproval` provides rich presentation for approval UIs
 */
export interface ToolDefinition<
  TArgs extends z.ZodType = z.ZodType,
  TReturns extends z.ZodType = z.ZodType,
> {
  readonly _tag: "ToolDefinition";
  readonly description: string;
  readonly approval: ApprovalMode;
  readonly args: TArgs;
  readonly returns: TReturns;
  readonly run: (input: z.output<TArgs>) => Promise<z.output<TReturns>>;
  readonly formatApproval?: ((
    input: z.output<TArgs>,
  ) => ApprovalPresentation) | undefined;
}

/**
 * Recursive tree of tools. Allows nested namespaces like `tools.github.issues.close`.
 */
export type ToolTree = {
  readonly [name: string]: ToolTree | ToolDefinition;
};

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export interface DefineToolInput<
  TArgs extends z.ZodType,
  TReturns extends z.ZodType,
> {
  description: string;
  approval: ApprovalMode;
  args: TArgs;
  returns: TReturns;
  run: (input: z.output<TArgs>) => Promise<z.output<TReturns>>;
  formatApproval?: (input: z.output<TArgs>) => ApprovalPresentation;
}

/**
 * Create a tool definition. This is the primary public API for tool authors.
 *
 * @example
 * ```ts
 * const closeTool = defineTool({
 *   description: "Close a GitHub issue",
 *   approval: "required",
 *   args: z.object({ owner: z.string(), repo: z.string(), issueNumber: z.number() }),
 *   returns: z.object({ number: z.number(), title: z.string(), state: z.string() }),
 *   run: async (input) => { ... },
 *   formatApproval: (input) => ({ title: `Close ${input.owner}/${input.repo}#${input.issueNumber}` }),
 * });
 * ```
 */
export function defineTool<
  TArgs extends z.ZodType,
  TReturns extends z.ZodType,
>(input: DefineToolInput<TArgs, TReturns>): ToolDefinition<TArgs, TReturns> {
  return {
    _tag: "ToolDefinition",
    description: input.description,
    approval: input.approval,
    args: input.args,
    returns: input.returns,
    run: input.run,
    formatApproval: input.formatApproval,
  };
}

// ---------------------------------------------------------------------------
// ToolTree Utilities
// ---------------------------------------------------------------------------

/**
 * Check if a value is a ToolDefinition.
 */
export function isToolDefinition(
  value: unknown,
): value is ToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value as { _tag: unknown })._tag === "ToolDefinition"
  );
}

/**
 * Walk a ToolTree and call `fn` for each tool with its dot-separated path.
 */
export function walkToolTree(
  tree: ToolTree,
  fn: (path: string, tool: ToolDefinition) => void,
  prefix = "",
): void {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isToolDefinition(value)) {
      fn(path, value);
    } else {
      walkToolTree(value as ToolTree, fn, path);
    }
  }
}

/**
 * Merge multiple ToolTrees into one. Later trees override earlier ones on conflict.
 */
export function mergeToolTrees(...trees: readonly ToolTree[]): ToolTree {
  const result: Record<string, ToolTree | ToolDefinition> = {};
  for (const tree of trees) {
    for (const [key, value] of Object.entries(tree)) {
      const existing = result[key];
      if (
        existing &&
        !isToolDefinition(existing) &&
        !isToolDefinition(value)
      ) {
        // Both are sub-trees — merge recursively
        result[key] = mergeToolTrees(
          existing as ToolTree,
          value as ToolTree,
        );
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}
