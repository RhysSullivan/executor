import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  makeToolInvokerFromTools,
  toExecutorTool,
} from "@executor/codemode-core";
import { makeSesExecutor } from "@executor/runtime-ses";

const numberPairInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    a: Schema.Number,
    b: Schema.Number,
  }),
);

const messageInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    message: Schema.String,
  }),
);


const tools = {
  "math.add": {
    inputSchema: numberPairInputSchema,
    execute: ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
  },
  "notifications.send": toExecutorTool({
    tool: {
      inputSchema: messageInputSchema,
      execute: ({ message }: { message: string }) => ({ delivered: true, message }),
    },
  }),
};

const run = Effect.gen(function* () {
  const outputWithTools = yield* makeSesExecutor().execute(
    "return await tools.math.add({ a: 20, b: 22 });",
    makeToolInvokerFromTools({ tools }),
  );

  const outputWithInvoker = yield* makeSesExecutor().execute(
    "return await tools.math.add({ a: 39, b: 3 });",
    makeToolInvokerFromTools({ tools }),
  );

  return {
    outputWithTools,
    outputWithInvoker,
  };
});

const result = await Effect.runPromise(run);
console.log(JSON.stringify(result, null, 2));
