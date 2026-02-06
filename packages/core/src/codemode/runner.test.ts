import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { describe } from "vitest";
import {
  createCodeModeRunner,
  defineTool,
} from "./runner.js";

describe("codemode runner", () => {
  it.effect("runs read tools without approval", () =>
    Effect.gen(function* () {
      const approvalCalls: Array<{ toolPath: string }> = [];
      const runner = createCodeModeRunner({
        tools: {
          calendar: {
            read: defineTool({
              kind: "read",
              approval: "auto",
              run: (input: { id: string }) => Effect.succeed({ id: input.id }),
            }),
          },
        },
        requestApproval: (request) =>
          Effect.sync(() => {
            approvalCalls.push({ toolPath: request.toolPath });
            return "approved" as const;
          }),
      });

      const result = yield* runner.run({
        code: "const event = await tools.calendar.read({ id: 'evt_1' }); return event.id;",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("evt_1");
      }
      expect(approvalCalls).toHaveLength(0);
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]?.decision).toBe("auto");
      expect(result.receipts[0]?.status).toBe("succeeded");
      expect(result.receipts[0]?.toolPath).toBe("calendar.read");
    }),
  );

  it.effect("blocks writes when denied and records receipt", () =>
    Effect.gen(function* () {
      let ranMutation = false;
      const runner = createCodeModeRunner({
        tools: {
          calendar: {
            update: defineTool({
              kind: "write",
              approval: "required",
              run: (_input: { id: string }) =>
                Effect.sync(() => {
                  ranMutation = true;
                  return { ok: true };
                }),
            }),
          },
        },
        requestApproval: () => Effect.succeed("denied" as const),
      });

      const result = yield* runner.run({
        code: "await tools.calendar.update({ id: 'evt_2' }); return 'done';",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("denied");
      }
      expect(ranMutation).toBe(false);
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]?.decision).toBe("denied");
      expect(result.receipts[0]?.status).toBe("denied");
      expect(result.receipts[0]?.toolPath).toBe("calendar.update");
    }),
  );

  it.effect("runs writes when approved and records success receipt", () =>
    Effect.gen(function* () {
      let ranMutation = false;
      const runner = createCodeModeRunner({
        tools: {
          calendar: {
            update: defineTool({
              kind: "write",
              approval: "required",
              run: (input: { id: string; title: string }) =>
                Effect.sync(() => {
                  ranMutation = true;
                  return { id: input.id, title: input.title };
                }),
            }),
          },
        },
        requestApproval: () => Effect.succeed("approved" as const),
      });

      const result = yield* runner.run({
        code: "const out = await tools.calendar.update({ id: 'evt_3', title: 'Dinner' }); return out.title;",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("Dinner");
      }
      expect(ranMutation).toBe(true);
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]?.decision).toBe("approved");
      expect(result.receipts[0]?.status).toBe("succeeded");
      expect(result.receipts[0]?.toolPath).toBe("calendar.update");
    }),
  );
});
