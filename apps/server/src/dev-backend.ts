import { createServerHandlersWithExecutor, type ServerHandlers } from "./main";
import { createServerExecutorHandle } from "./services/executor";

export type HotBackend = ServerHandlers & {
  readonly dispose: () => Promise<void>;
};

export const createHotBackend = async (): Promise<HotBackend> => {
  const handle = await createServerExecutorHandle();
  const handlers = await createServerHandlersWithExecutor(handle.executor);

  return {
    ...handlers,
    dispose: async () => {
      await handlers.api.dispose().catch(() => undefined);
      await handlers.mcp.close().catch(() => undefined);
      await handle.dispose();
    },
  };
};
