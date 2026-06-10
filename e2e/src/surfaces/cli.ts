// CLI/TUI surface: a real PTY via terminal-control. The scenario drives the
// session (type/press/waitForText) and asserts on the rendered screen with
// vitest; pass `record` to capture an asciinema-style cast file if wanted.
import { Effect } from "effect";
import { TerminalControl, type Session } from "@kitlangton/terminal-control";

export interface CliSurface {
  readonly session: <T>(
    command: readonly [string, ...string[]],
    drive: (session: Session) => Promise<T>,
    options?: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly record?: string;
    },
  ) => Effect.Effect<T>;
}

// acquireUseRelease so a vitest timeout (fiber interruption) still tears the
// PTY down instead of leaking the child process.
export const makeCliSurface = (): CliSurface => ({
  session: (command, drive, options) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const tc = await TerminalControl.make();
        const session: Session = await tc.launch({
          command,
          cwd: options?.cwd,
          env: options?.env,
          record: options?.record,
        });
        return { tc, session };
      }),
      ({ session }) => Effect.promise(() => drive(session)),
      ({ tc, session }) =>
        Effect.promise(async () => {
          await session.stop().catch(() => {});
          await tc[Symbol.asyncDispose]();
        }),
    ),
});
