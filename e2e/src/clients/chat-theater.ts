// Chat theater: agent-chat presentation over REAL mcporter MCP calls — no
// inference, no third-party agent binary. The scenario stays in Effect land
// making real calls; a forked PTY runs the chat renderer
// (agent-chat-tui.ts) and this driver feeds it events, so the terminal.cast
// reads like a developer chatting with an agent while every tool spinner
// brackets the genuine call it narrates.
//
// Division of labor in the e2e stack:
//   - chat theater (this): deterministic PRODUCT-flow recordings
//   - replay brain + real client (replay-brain.ts): CLIENT-behavior tests
//     (OpenCode/Claude Code protocol handling), still no inference
//   - real-inference evals: a separate axis entirely — performance
//     distributions, not pass/fail scenarios
import { fileURLToPath } from "node:url";

import { Effect, Exit, Fiber } from "effect";

import type { CliSurface } from "../surfaces/cli";

const RENDERER = fileURLToPath(new URL("./agent-chat-tui.ts", import.meta.url));

interface TheaterEvent {
  readonly type: "user" | "assistant" | "tool-start" | "tool-end" | "status" | "done";
  readonly [key: string]: unknown;
}

export interface ChatTheater {
  /** The human's chat line, typed out on screen. */
  readonly user: (text: string) => Effect.Effect<void>;
  /** The agent's reply, streamed on screen. */
  readonly assistant: (text: string) => Effect.Effect<void>;
  /** Run a REAL effect behind a live tool spinner; the spinner runs exactly
   *  as long as the call does and resolves to ✓/✗ with its outcome. */
  readonly tool: <A, E, R>(
    label: string,
    work: Effect.Effect<A, E, R>,
    note?: (result: A) => string | undefined,
  ) => Effect.Effect<A, E, R>;
  /** A dim narrator line (e.g. "waiting for the browser hop"). */
  readonly status: (text: string) => Effect.Effect<void>;
}

/**
 * Open a recorded PTY running the chat renderer, hand the scenario a
 * ChatTheater handle, and close the session (footer + exit) when the body
 * finishes — success or failure, so the cast always ends cleanly.
 */
export const withChatTheater = <A, E, R>(
  cli: CliSurface,
  options: {
    readonly title: string;
    readonly record: string;
    readonly viewport?: { readonly cols: number; readonly rows: number };
  },
  body: (theater: ChatTheater) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const queue: TheaterEvent[] = [];
    let closed = false;

    const push = (event: TheaterEvent) =>
      Effect.sync(() => {
        if (!closed) queue.push(event);
      });

    // The PTY pump: forward queued events as base64 lines (keystroke-safe),
    // and return once the renderer paints its completion footer.
    const pump = cli.session(
      ["bun", RENDERER, options.title],
      async (term) => {
        // Don't type until the renderer has painted its header — before that
        // it hasn't set raw mode yet, and the PTY would echo the event line
        // into the recording.
        await term.screen.waitForText(options.title, { timeoutMs: 30_000 });
        const deadline = Date.now() + 30 * 60 * 1000;
        for (;;) {
          const event = queue.shift();
          if (event) {
            const line = Buffer.from(JSON.stringify(event)).toString("base64");
            await term.keyboard.type(`${line}\n`);
            if (event.type === "done") break;
            continue;
          }
          if (Date.now() > deadline) break;
          await new Promise<void>((tick) => setTimeout(tick, 40));
        }
        await term.screen.waitForText("session complete", { timeoutMs: 60_000 });
      },
      {
        record: options.record,
        viewport: options.viewport ?? { cols: 100, rows: 32 },
      },
    );
    const pumpFiber = yield* Effect.forkChild(Effect.exit(pump));

    const theater: ChatTheater = {
      user: (text) => push({ type: "user", text }),
      assistant: (text) => push({ type: "assistant", text }),
      status: (text) => push({ type: "status", text }),
      tool: (label, work, note) =>
        Effect.gen(function* () {
          yield* push({ type: "tool-start", label });
          const exit = yield* Effect.exit(work);
          if (Exit.isSuccess(exit)) {
            yield* push({ type: "tool-end", ok: true, note: note?.(exit.value) });
            return exit.value;
          }
          yield* push({ type: "tool-end", ok: false, note: "failed" });
          return yield* exit;
        }),
    };

    const result = yield* Effect.exit(body(theater));
    yield* push({ type: "done" });
    closed = true;
    yield* Fiber.join(pumpFiber);
    return yield* result;
  });
