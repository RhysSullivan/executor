type SchedulerLike = {
  runAfter: (delayMs: number, functionReference: any, args: any) => Promise<any>;
};

export function isSchedulerDisabled(): boolean {
  return process.env.DISABLE_CONVEX_SCHEDULER === "1";
}

export async function safeRunAfter(
  scheduler: SchedulerLike | undefined,
  delayMs: number,
  functionReference: any,
  args: any,
): Promise<boolean> {
  if (!scheduler || isSchedulerDisabled()) {
    return false;
  }

  try {
    await scheduler.runAfter(delayMs, functionReference, args);
    return true;
  } catch {
    // Best effort only.
    return false;
  }
}
