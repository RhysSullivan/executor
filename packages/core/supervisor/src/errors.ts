import { Data } from "effect";

export class ReadinessTimeout extends Data.TaggedError("ReadinessTimeout")<{
  readonly url: string;
  readonly elapsedMs: number;
  readonly attempts: number;
}> {}
