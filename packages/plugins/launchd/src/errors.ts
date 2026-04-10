import { Data } from "effect";

export class LaunchdUnsupportedPlatform extends Data.TaggedError("LaunchdUnsupportedPlatform")<{
  readonly platform: string;
  readonly message: string;
}> {}

export class LaunchdBootstrapFailed extends Data.TaggedError("LaunchdBootstrapFailed")<{
  readonly label: string;
  readonly plistPath: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}> {}

export class LaunchdReadinessTimeout extends Data.TaggedError("LaunchdReadinessTimeout")<{
  readonly label: string;
  readonly url: string;
  readonly elapsedMs: number;
}> {}

export class LaunchdBootoutFailed extends Data.TaggedError("LaunchdBootoutFailed")<{
  readonly label: string;
  readonly plistPath: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}> {}
