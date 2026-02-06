import { Effect } from "effect";

export const healthcheck = Effect.succeed("ok");
export * from "./codemode/runner.js";
