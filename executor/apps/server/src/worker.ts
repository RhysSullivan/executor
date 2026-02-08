import { ConvexClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";
import { ExecutorDatabase } from "./database";
import { TaskEventHub } from "./events";
import { LocalBunRuntime } from "./runtimes/local-bun-runtime";
import { VercelSandboxRuntime } from "./runtimes/vercel-sandbox-runtime";
import { ExecutorService } from "./service";
import { loadExternalTools, parseToolSourcesFromEnv } from "./tool-sources";
import { DEFAULT_TOOLS } from "./tools";

const convexUrl = Bun.env.EXECUTOR_CONVEX_URL ?? Bun.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const internalBaseUrl = Bun.env.EXECUTOR_INTERNAL_BASE_URL ?? Bun.env.EXECUTOR_PUBLIC_BASE_URL ?? "http://127.0.0.1:4001";
const internalToken = Bun.env.EXECUTOR_INTERNAL_TOKEN ?? "executor_internal_local_dev_token";
const pollMs = Number(Bun.env.EXECUTOR_WORKER_POLL_MS ?? "2000");
const queueBatchSize = Number(Bun.env.EXECUTOR_WORKER_BATCH_SIZE ?? "20");

const toolSourceConfigs = (() => {
  try {
    return parseToolSourcesFromEnv(Bun.env.EXECUTOR_TOOL_SOURCES);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] invalid EXECUTOR_TOOL_SOURCES: ${message}`);
    return [];
  }
})();

const { tools: externalTools, warnings: externalToolWarnings } = await loadExternalTools(toolSourceConfigs);
if (externalToolWarnings.length > 0) {
  for (const warning of externalToolWarnings) {
    console.warn(`[worker] ${warning}`);
  }
}

const service = new ExecutorService(
  new ExecutorDatabase(convexUrl),
  new TaskEventHub(),
  [
    new LocalBunRuntime(),
    new VercelSandboxRuntime({
      controlPlaneBaseUrl: internalBaseUrl,
      internalToken,
      runtime: Bun.env.EXECUTOR_VERCEL_SANDBOX_RUNTIME as "node24" | "node22" | undefined,
    }),
  ],
  [...DEFAULT_TOOLS, ...externalTools],
  { autoExecuteTasks: false },
);

const convexClient = new ConvexClient(convexUrl, {
  unsavedChangesWarning: false,
});

let draining = false;

async function drainQueue(trigger: string): Promise<void> {
  if (draining) {
    return;
  }

  draining = true;
  try {
    while (true) {
      const queuedTaskIds = await service.listQueuedTaskIds(queueBatchSize);
      if (queuedTaskIds.length === 0) {
        return;
      }

      console.log(`[worker] ${trigger}: processing ${queuedTaskIds.length} queued task(s)`);
      for (const taskId of queuedTaskIds) {
        await service.runTask(taskId);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] drain failed: ${message}`);
  } finally {
    draining = false;
  }
}

const queueSubscription = convexClient.onUpdate(
  api.database.listQueuedTaskIds,
  { limit: 1 },
  (taskIds) => {
    if (taskIds.length > 0) {
      void drainQueue("onUpdate");
    }
  },
  (error) => {
    console.warn(`[worker] queue watcher error: ${error.message}`);
  },
);

const interval = setInterval(() => {
  void drainQueue("interval");
}, pollMs);

await drainQueue("startup");

function shutdown(signal: string): void {
  console.log(`[worker] received ${signal}, shutting down...`);
  queueSubscription.unsubscribe();
  clearInterval(interval);
  void convexClient.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`[worker] listening for queued tasks via Convex (${convexUrl})`);
