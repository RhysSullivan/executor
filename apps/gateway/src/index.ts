import { healthcheck } from "@openassistant/core";
import { Effect } from "effect";

const program = Effect.flatMap(healthcheck, (status) =>
  Effect.sync(() => {
    console.log(`[gateway] healthcheck=${status}`);
  }),
);

await Effect.runPromise(program);
