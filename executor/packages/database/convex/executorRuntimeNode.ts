import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { dispatchCodeWithCloudflareWorkerLoader } from "../../core/src/runtimes/cloudflare/worker/loader-runtime";

export const dispatchCloudflareWorker = internalAction({
  args: {
    taskId: v.string(),
    code: v.string(),
    timeoutMs: v.number(),
  },
  handler: async (_ctx, args) => {
    return await dispatchCodeWithCloudflareWorkerLoader(args);
  },
});
