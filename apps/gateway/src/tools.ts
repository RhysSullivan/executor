import { defineTool, type ToolTree } from "@openassistant/core";
import { Effect } from "effect";
import type { InMemoryCalendarStore } from "./calendar-store.js";

export function createToolTree(calendarStore: InMemoryCalendarStore): ToolTree {
  return {
    calendar: {
      update: defineTool({
        kind: "write",
        approval: "required",
        run: (input: { title: string; startsAt: string; notes?: string }) =>
          Effect.sync(() => calendarStore.update(input)),
        previewInput: (input) => `${input.title} @ ${input.startsAt}`,
      }),
      list: defineTool({
        kind: "read",
        approval: "auto",
        run: () => Effect.sync(() => calendarStore.list()),
      }),
    },
  };
}
