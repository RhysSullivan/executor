import type {
  ExecuteRunInput,
  ExecuteRunResult,
  ExecutorRunClient,
} from "@executor-v2/sdk";
import { z } from "zod";

export const ExecuteToolInputSchema = z.object({
  code: z.string(),
  timeoutMs: z.number().int().positive().optional(),
});

export type ExecuteToolInput = z.infer<typeof ExecuteToolInputSchema>;

export type ExecuteToolOutput = ExecuteRunResult;

export type AiToolFactory<TTool, TInput, TOutput> = (definition: {
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput) => Promise<TOutput>;
}) => TTool;

export type ToAiSdkToolsOptions<TTool> = {
  runClient: ExecutorRunClient;
  makeTool: AiToolFactory<TTool, ExecuteToolInput, ExecuteToolOutput>;
  defaults?: {
    timeoutMs?: number;
  };
};

const withDefaults = (
  input: ExecuteToolInput,
  defaults?: {
    timeoutMs?: number;
  },
): ExecuteRunInput => ({
  code: input.code,
  timeoutMs: input.timeoutMs ?? defaults?.timeoutMs,
});

export const toAiSdkTools = <TTool>(
  options: ToAiSdkToolsOptions<TTool>,
): {
  execute: TTool;
} => ({
  execute: options.makeTool({
    description: "Execute JavaScript against configured Executor runtime",
    inputSchema: ExecuteToolInputSchema,
    execute: async (input) =>
      options.runClient.execute(withDefaults(input, options.defaults)),
  }),
});
