import { Context } from "effect";
import type { ExecutionEngine } from "@executor/execution";

export class ExecutionEngineService extends Context.Tag("ExecutionEngineService")<
  ExecutionEngineService,
  ExecutionEngine
>() {}
