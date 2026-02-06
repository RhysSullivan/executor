/**
 * Codemode runner — executes LLM-generated TypeScript in a node:vm sandbox.
 *
 * The sandbox exposes only the `tools` object. No fetch, no process, no Bun,
 * no require, no import. Tool functions are wrapped so toString() doesn't
 * leak implementation source.
 */

import { createContext, runInContext } from "node:vm";
import type {
  ApprovalDecision,
  ApprovalPresentation,
  ApprovalRequest,
  ToolCallReceipt,
  ToolDefinition,
  ToolTree,
} from "./tools.js";
import { isToolDefinition } from "./tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly receipts: readonly ToolCallReceipt[];
}

export interface RunnerOptions {
  /** The tool tree to expose in the sandbox. */
  readonly tools: ToolTree;
  /** Called when a tool with `approval: "required"` is invoked. */
  readonly requestApproval: (
    request: ApprovalRequest,
  ) => Promise<ApprovalDecision>;
  /** Execution timeout in ms. Defaults to 30_000. */
  readonly timeoutMs?: number | undefined;
  /** Injectable clock for testing. */
  readonly now?: (() => number) | undefined;
  /** Injectable ID generator for testing. */
  readonly newCallId?: (() => string) | undefined;
}

export interface Runner {
  /** Execute a code string in the sandbox. Never throws. */
  run(code: string): Promise<RunResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_PREVIEW = 180;
const MAX_APPROVAL_DETAILS = 500;

function preview(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > MAX_PREVIEW ? s.slice(0, MAX_PREVIEW) + "..." : s;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferApprovalAction(toolPath: string): {
  action: NonNullable<ApprovalPresentation["action"]>;
  isDestructive: boolean;
} {
  const lower = toolPath.toLowerCase();
  if (/(delete|remove|destroy|purge)/.test(lower)) {
    return { action: "delete", isDestructive: true };
  }
  if (/(create|add|insert|provision)/.test(lower)) {
    return { action: "create", isDestructive: false };
  }
  if (/(update|set|patch|edit|rename)/.test(lower)) {
    return { action: "update", isDestructive: false };
  }
  if (/(get|list|search|find|read)/.test(lower)) {
    return { action: "read", isDestructive: false };
  }
  return { action: "execute", isDestructive: false };
}

function inferResourceType(toolPath: string): string | undefined {
  const parts = toolPath.split(".").filter(Boolean);
  const candidate = parts.at(-2) ?? parts.at(-1);
  if (!candidate) return undefined;
  return candidate
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function extractResourceIds(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const ids: string[] = [];
  const candidateKeys = ["id", "ids", "name", "slug", "key", "idOrName"];
  for (const key of candidateKeys) {
    const value = input[key];
    if (typeof value === "string" || typeof value === "number") {
      ids.push(String(value));
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" || typeof item === "number") {
          ids.push(String(item));
        }
      }
    }
  }
  return ids.slice(0, 5);
}

function extractCount(input: unknown): number | undefined {
  if (!isRecord(input)) return undefined;
  const raw = input["count"];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function buildDefaultApprovalPresentation(
  toolPath: string,
  input: unknown,
): ApprovalPresentation {
  const { action, isDestructive } = inferApprovalAction(toolPath);
  const actionVerb = action === "execute"
    ? "Run"
    : action.charAt(0).toUpperCase() + action.slice(1);
  const resourceType = inferResourceType(toolPath);
  const resourceIds = extractResourceIds(input);
  const count = extractCount(input);
  const rawPreview = preview(input);

  const idDetail = resourceIds.length > 0 ? `Target: ${resourceIds.join(", ")}` : undefined;
  const argsDetail = `Arguments: ${rawPreview}`;
  const details = [idDetail, argsDetail].filter(Boolean).join("\n");

  return {
    title: `${actionVerb} via ${toolPath}`,
    details: details.length > MAX_APPROVAL_DETAILS
      ? `${details.slice(0, MAX_APPROVAL_DETAILS)}...`
      : details,
    action,
    resourceType,
    resourceIds: resourceIds.length > 0 ? resourceIds : undefined,
    count,
    isDestructive,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Include cause if present (e.g. nested API errors)
    const msg = error.message;
    if (error.cause) {
      return `${msg} (cause: ${describeError(error.cause)})`;
    }
    return msg;
  }
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return String(error);
  // Try to get a meaningful representation
  try {
    const json = JSON.stringify(error, null, 0);
    // If it's just "{}", try to find something useful
    if (json === "{}" || json === "[]") {
      const proto = Object.getPrototypeOf(error);
      const name = proto?.constructor?.name;
      return name && name !== "Object" ? `[${name}]` : String(error);
    }
    return json;
  } catch {
    return String(error);
  }
}

let callIdCounter = 0;
function defaultNewCallId(): string {
  return `call_${++callIdCounter}_${Date.now().toString(36)}`;
}

/**
 * Wrap a function so toString() doesn't leak the source.
 */
function wrapFn<T extends (...args: unknown[]) => unknown>(fn: T): T {
  const wrapped = ((...args: unknown[]) => fn(...args)) as T;
  Object.defineProperty(wrapped, "toString", {
    value: () => "function() { [native code] }",
    configurable: false,
    writable: false,
  });
  Object.defineProperty(wrapped, "name", {
    value: fn.name || "tool",
    configurable: false,
    writable: false,
  });
  return wrapped;
}

// ---------------------------------------------------------------------------
// Materializer — converts ToolTree to plain JS objects for the sandbox
// ---------------------------------------------------------------------------

interface MaterializeContext {
  receipts: ToolCallReceipt[];
  requestApproval: RunnerOptions["requestApproval"];
  now: () => number;
  newCallId: () => string;
}

function materializeToolTree(
  tree: ToolTree,
  ctx: MaterializeContext,
  prefix = "",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isToolDefinition(value)) {
      result[key] = createToolInvoker(path, value, ctx);
    } else {
      result[key] = materializeToolTree(value as ToolTree, ctx, path);
    }
  }

  return result;
}

function createToolInvoker(
  toolPath: string,
  tool: ToolDefinition,
  ctx: MaterializeContext,
): (...args: unknown[]) => Promise<unknown> {
  return wrapFn(async (input: unknown) => {
    const callId = ctx.newCallId();
    const timestamp = ctx.now();
    const inputPreview = preview(input);

    // Validate input with Zod
    const parseResult = tool.args.safeParse(input);
    if (!parseResult.success) {
      const errorMsg = `Input validation failed: ${parseResult.error.message}`;
      ctx.receipts.push({
        callId,
        toolPath,
        approval: tool.approval,
        decision: "auto",
        status: "failed",
        timestamp,
        inputPreview,
        error: errorMsg,
      });
      throw new Error(errorMsg);
    }

    const validatedInput = parseResult.data;

    // Check approval for "required" tools
    if (tool.approval === "required") {
      const presentation: ApprovalPresentation = tool.formatApproval
        ? tool.formatApproval(validatedInput)
        : buildDefaultApprovalPresentation(toolPath, validatedInput);

      const decision = await ctx.requestApproval({
        callId,
        toolPath,
        input: validatedInput,
        preview: presentation,
      });

      if (decision === "denied") {
        ctx.receipts.push({
          callId,
          toolPath,
          approval: "required",
          decision: "denied",
          status: "denied",
          timestamp,
          inputPreview,
        });
        return undefined;
      }

      // Approved — continue to execution
      try {
        const output = await tool.run(validatedInput);
        ctx.receipts.push({
          callId,
          toolPath,
          approval: "required",
          decision: "approved",
          status: "succeeded",
          timestamp,
          inputPreview,
          outputPreview: preview(output),
        });
        return output;
      } catch (error) {
        const errorMsg = describeError(error);
        ctx.receipts.push({
          callId,
          toolPath,
          approval: "required",
          decision: "approved",
          status: "failed",
          timestamp,
          inputPreview,
          error: errorMsg,
        });
        throw error;
      }
    }

    // Auto-approved tool
    try {
      const output = await tool.run(validatedInput);
      ctx.receipts.push({
        callId,
        toolPath,
        approval: "auto",
        decision: "auto",
        status: "succeeded",
        timestamp,
        inputPreview,
        outputPreview: preview(output),
      });
      return output;
    } catch (error) {
      const errorMsg = describeError(error);
      ctx.receipts.push({
        callId,
        toolPath,
        approval: "auto",
        decision: "auto",
        status: "failed",
        timestamp,
        inputPreview,
        error: errorMsg,
      });
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

function createSandboxContext(tools: Record<string, unknown>): object {
  // Object.create(null) as base — the VM gets its own built-in globals
  // (Array, Object, Promise, etc.) but nothing from the host.
  const ctx = createContext(Object.create(null));
  const g: Record<string, unknown> = runInContext("globalThis", ctx);

  // Inject tools — the only external capability
  g["tools"] = tools;

  // No-op console (sandbox already has no console)
  g["console"] = {
    log: () => {},
    warn: () => {},
    error: () => {},
    info: () => {},
    debug: () => {},
  };

  // Explicitly block dangerous things with clear error messages.
  // The VM's own globals (Array, Object, Math, JSON, Date, Promise, etc.)
  // are already present and safe — they're sandbox-scoped copies.
  const blocked = (name: string) => {
    Object.defineProperty(g, name, {
      get() {
        throw new Error(
          `${name} is not available in the sandbox. Use tools.* to interact with external services.`,
        );
      },
      configurable: false,
    });
  };
  blocked("fetch");
  blocked("require");
  blocked("process");
  blocked("Bun");
  blocked("setTimeout");
  blocked("setInterval");

  return ctx;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function createRunner(options: RunnerOptions): Runner {
  const {
    tools,
    requestApproval,
    timeoutMs = 30_000,
    now = Date.now,
    newCallId = defaultNewCallId,
  } = options;

  return {
    async run(code: string): Promise<RunResult> {
      const receipts: ToolCallReceipt[] = [];

      const materialCtx: MaterializeContext = {
        receipts,
        requestApproval,
        now,
        newCallId,
      };

      const materializedTools = materializeToolTree(tools, materialCtx);
      const sandbox = createSandboxContext(materializedTools);

      try {
        const wrappedCode = `(async (tools) => {\n"use strict";\n${code}\n})(tools)`;
        const resultPromise = runInContext(wrappedCode, sandbox, {
          timeout: timeoutMs,
        });

        // runInContext returns a Promise for async code
        const value = await resultPromise;

        const hasDenial = receipts.some((r) => r.status === "denied");
        if (hasDenial) {
          return { ok: false, value, receipts, error: "One or more tool calls were denied" };
        }

        return { ok: true, value, receipts };
      } catch (error) {
        return {
          ok: false,
          error: describeError(error),
          receipts,
        };
      }
    },
  };
}
