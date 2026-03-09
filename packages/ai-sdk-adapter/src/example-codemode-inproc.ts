import { tool } from "ai";
import * as Effect from "effect/Effect";
import { z } from "zod";

import { makeToolInvokerFromTools } from "@executor/codemode-core";
import { makeSesExecutor } from "@executor/runtime-ses";

import {
  createCodeTool,
  createToolsFromAiSdkTools,
} from "./index";

const addNumbers = tool({
  description: "Add two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
});

const notify = tool({
  description: "Send notification message",
  inputSchema: z.object({ message: z.string() }),
  execute: async ({ message }: { message: string }) => ({ delivered: true, message }),
});

const tools = createToolsFromAiSdkTools({
  tools: {
    "math.add": addNumbers,
    "notifications.send": notify,
  },
  sourceKey: "in_memory.demo",
});

const executor = makeSesExecutor();
const toolInvoker = makeToolInvokerFromTools({ tools });

export const codemode = createCodeTool({
  toolInvoker,
  executor,
});

export const runCodemodeDemo = async () =>
  Effect.runPromise(
    executor.execute(
      [
        "const math = await tools.math.add({ a: 2, b: 3 });",
        "await tools.notifications.send({ message: `sum is ${math.sum}` });",
        "return math;",
      ].join("\n"),
      toolInvoker,
    ),
  );
