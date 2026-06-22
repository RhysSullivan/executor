import { expect } from "@effect/vitest";
import { Effect } from "effect";

import type { McpCallResult } from "../src/surfaces/mcp";
import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";

type CellEvent = {
  readonly type?: unknown;
  readonly item?: {
    readonly type?: unknown;
    readonly content?: {
      readonly type?: unknown;
      readonly text?: unknown;
    };
    readonly notification?: {
      readonly message?: unknown;
      readonly data?: unknown;
    };
  };
};

type CellObservation = {
  readonly status?: unknown;
  readonly cellId?: unknown;
  readonly cursor?: unknown;
  readonly events?: readonly CellEvent[];
  readonly result?: {
    readonly result?: unknown;
    readonly output?: readonly unknown[];
  };
};

const cellObservation = (result: McpCallResult): CellObservation => {
  const structured = (result.raw as { readonly structuredContent?: unknown }).structuredContent;
  expect(structured, `cell call returned structured content: ${result.text.slice(0, 300)}`).toEqual(
    expect.any(Object),
  );
  return structured as CellObservation;
};

const eventTypes = (observation: CellObservation): readonly unknown[] =>
  observation.events?.map((event) => event.type) ?? [];

const eventsOf = (observation: CellObservation): readonly CellEvent[] => observation.events ?? [];

const textOutput = (events: readonly CellEvent[]): readonly string[] =>
  events.flatMap((event) =>
    event.type === "output" &&
    event.item?.type === "content" &&
    event.item.content?.type === "text" &&
    typeof event.item.content.text === "string"
      ? [event.item.content.text]
      : [],
  );

const notificationOutput = (events: readonly CellEvent[]): readonly string[] =>
  events.flatMap((event) =>
    event.type === "output" &&
    event.item?.type === "notification" &&
    typeof event.item.notification?.message === "string"
      ? [event.item.notification.message]
      : [],
  );

const requireString = (value: unknown, label: string): string => {
  expect(value, label).toEqual(expect.any(String));
  return value as string;
};

const requireNumber = (value: unknown, label: string): number => {
  expect(value, label).toEqual(expect.any(Number));
  return value as number;
};

scenario(
  "Codemode · persistent cells yield, wait, notify, and terminate through MCP",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);

    const tools = yield* session.listTools();
    expect(tools, "persistent cell tools are advertised").toEqual(
      expect.arrayContaining(["execute_cell", "wait_cell", "terminate_cell"]),
    );

    const first = yield* session.call("execute_cell", {
      yieldAfterMs: 250,
      code: [
        'text("phase 1");',
        "await yield_control();",
        'text("phase 2");',
        "await yieldControl();",
        'notify({ message: "cell almost done", data: { phase: 3 } });',
        'text("phase 3");',
        'return { cell: "done" };',
      ].join("\n"),
    });
    expect(first.ok, `execute_cell starts and reaches the first yield: ${first.text}`).toBe(true);

    const firstCell = cellObservation(first);
    expect(firstCell.status, "the first observation leaves the cell running").toBe("running");
    const cellId = requireString(firstCell.cellId, "execute_cell returns a reusable cell id");
    let cursor = requireNumber(firstCell.cursor, "execute_cell returns an event cursor");
    const firstEvents: CellEvent[] = [...eventsOf(firstCell)];
    for (
      let attempt = 0;
      attempt < 2 && !firstEvents.some((event) => event.type === "yielded");
      attempt++
    ) {
      const yielded = yield* session.call("wait_cell", {
        cellId,
        after: cursor,
        timeoutMs: 5_000,
      });
      expect(yielded.ok, `wait_cell observes the first yield: ${yielded.text}`).toBe(true);
      const yieldedCell = cellObservation(yielded);
      cursor = requireNumber(yieldedCell.cursor, "wait_cell advances the cursor");
      firstEvents.push(...eventsOf(yieldedCell));
    }
    expect(
      firstEvents.map((event) => event.type),
      "the first phase includes output and an explicit yield checkpoint",
    ).toEqual(expect.arrayContaining(["output", "yielded"]));
    expect(textOutput(firstEvents), "phase 1 output is visible immediately").toContain("phase 1");

    const secondEvents: CellEvent[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = yield* session.call("wait_cell", {
        cellId,
        after: cursor,
        timeoutMs: 5_000,
      });
      expect(next.ok, `wait_cell observes phase 2 progress: ${next.text}`).toBe(true);
      const nextCell = cellObservation(next);
      cursor = requireNumber(nextCell.cursor, "wait_cell advances the phase 2 cursor");
      secondEvents.push(...eventsOf(nextCell));
      if (
        textOutput(secondEvents).includes("phase 2") &&
        secondEvents.some((event) => event.type === "yielded")
      ) {
        break;
      }
    }
    expect(textOutput(secondEvents), "phase 2 output is delivered incrementally").toContain(
      "phase 2",
    );
    expect(
      secondEvents.map((event) => event.type),
      "phase 2 includes another explicit yield checkpoint",
    ).toContain("yielded");

    const finalEvents: CellEvent[] = [];
    let completedCell: CellObservation | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = yield* session.call("wait_cell", {
        cellId,
        after: cursor,
        timeoutMs: 5_000,
      });
      expect(next.ok, `wait_cell observes completion progress: ${next.text}`).toBe(true);
      const nextCell = cellObservation(next);
      cursor = requireNumber(nextCell.cursor, "wait_cell advances the completion cursor");
      finalEvents.push(...eventsOf(nextCell));
      if (nextCell.status === "completed") {
        completedCell = nextCell;
        break;
      }
    }
    expect(completedCell, "wait_cell eventually observes the completed cell").toEqual(
      expect.any(Object),
    );

    const observedCompletedCell = completedCell as CellObservation;
    expect(observedCompletedCell.status, "the final observation is completed").toBe("completed");
    expect(
      finalEvents.map((event) => event.type),
      "completion includes final outputs and terminal event",
    ).toEqual(expect.arrayContaining(["output", "completed"]));
    expect(
      notificationOutput(finalEvents),
      "notifications are emitted as structured events",
    ).toContain("cell almost done");
    expect(textOutput(finalEvents), "phase 3 output is visible before completion").toContain(
      "phase 3",
    );
    expect(
      observedCompletedCell.result?.result,
      "the returned value is preserved on completion",
    ).toEqual({ cell: "done" });

    const timerRun = yield* session.call("execute_cell", {
      yieldAfterMs: 10,
      code: [
        "await new Promise((resolve) => setTimeout(resolve, 50));",
        'text("timer fired");',
        'return { timer: "done" };',
      ].join("\n"),
    });
    expect(timerRun.ok, `execute_cell starts a timer-backed cell: ${timerRun.text}`).toBe(true);
    let timerCell = cellObservation(timerRun);
    const timerCellId = requireString(timerCell.cellId, "timer cell id is reusable");
    let timerCursor = requireNumber(timerCell.cursor, "timer cell returns an event cursor");
    const timerEvents: CellEvent[] = [...eventsOf(timerCell)];
    for (let attempt = 0; attempt < 5 && timerCell.status !== "completed"; attempt++) {
      const next = yield* session.call("wait_cell", {
        cellId: timerCellId,
        after: timerCursor,
        timeoutMs: 5_000,
      });
      expect(next.ok, `wait_cell observes timer-backed completion: ${next.text}`).toBe(true);
      timerCell = cellObservation(next);
      timerCursor = requireNumber(timerCell.cursor, "wait_cell advances the timer cursor");
      timerEvents.push(...eventsOf(timerCell));
    }
    expect(timerCell.status, "timer-backed cells can complete after the first observation").toBe(
      "completed",
    );
    expect(textOutput(timerEvents), "timer output is visible on completion").toContain(
      "timer fired",
    );
    expect(timerCell.result?.result, "timer cell return value is preserved").toEqual({
      timer: "done",
    });

    const running = yield* session.call("execute_cell", {
      yieldAfterMs: 250,
      code: [
        "let i = 0;",
        "while (true) {",
        "  text(`loop ${i}`);",
        "  i += 1;",
        "  await yield_control();",
        "}",
      ].join("\n"),
    });
    expect(running.ok, `execute_cell starts a cooperative long-running cell: ${running.text}`).toBe(
      true,
    );
    const runningCell = cellObservation(running);
    expect(runningCell.status, "the loop cell is running after its first yield").toBe("running");
    const runningCellId = requireString(runningCell.cellId, "loop cell id is reusable");

    const terminated = yield* session.call("terminate_cell", {
      cellId: runningCellId,
    });
    expect(terminated.ok, `terminate_cell returns a terminal observation: ${terminated.text}`).toBe(
      true,
    );
    const terminatedCell = cellObservation(terminated);
    expect(terminatedCell.status, "terminate_cell marks the cell terminated").toBe("terminated");
    expect(eventTypes(terminatedCell), "the termination event is visible to clients").toContain(
      "terminated",
    );
  }),
);
