import type { MutationCtx } from "../../convex/_generated/server";

type SchedulerLike = Pick<MutationCtx, "scheduler">["scheduler"];

function isTestProcess(): boolean {
  if (process.env.NODE_ENV === "test") {
    return true;
  }

  if (process.env.BUN_TEST === "1") {
    return true;
  }

  const argv = process.argv.join(" ");
  return argv.includes(".test.ts");
}

export function isSchedulerDisabled(): boolean {
  return process.env.DISABLE_CONVEX_SCHEDULER === "1" || isTestProcess();
}

export async function safeRunAfter(
  scheduler: SchedulerLike | undefined,
  delayMs: number,
  functionReference: Parameters<SchedulerLike["runAfter"]>[1],
  args?: unknown,
): Promise<boolean> {
  if (!scheduler || isSchedulerDisabled()) {
    return false;
  }

  try {
    if (args === undefined) {
      await scheduler.runAfter(delayMs, functionReference);
    } else {
      await scheduler.runAfter(delayMs, functionReference, args as any);
    }
    return true;
  } catch {
    // Best effort only.
    return false;
  }
}
