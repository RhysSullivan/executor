import type { StandardSchemaV1 } from "@standard-schema/spec";
import type * as Effect from "effect/Effect";

/** Branded tool path */
export type ToolPath = string & { readonly __toolPath: unique symbol };

export const asToolPath = (value: string): ToolPath => value as ToolPath;

/** Standard Schema alias */
export type StandardSchema<Input = unknown, Output = unknown> = StandardSchemaV1<Input, Output>;

/** A tool that can be invoked */
export interface Tool {
  readonly path: ToolPath;
  readonly description?: string;
  readonly inputSchema: StandardSchema;
  readonly outputSchema?: StandardSchema;
  readonly execute: (input: unknown) => unknown | Promise<unknown>;
}

/** Invoke a tool by path from inside a sandbox */
export interface SandboxToolInvoker {
  invoke(input: { path: string; args: unknown }): Effect.Effect<unknown, unknown>;
}

/** Result of executing code in a sandbox */
export type ExecuteResult = {
  result: unknown;
  error?: string;
  logs?: string[];
};

/** Executes code in a sandboxed runtime with tool access */
export interface CodeExecutor {
  execute(code: string, toolInvoker: SandboxToolInvoker): Effect.Effect<ExecuteResult, unknown>;
}

/** Accept-anything schema for tools with no input validation */
export const unknownInputSchema: StandardSchema = {
  "~standard": {
    version: 1,
    vendor: "@executor/codemode-core",
    validate: (value: unknown) => ({
      value,
    }),
  },
};
