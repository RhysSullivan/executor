import { createServerHandlers, type ServerHandlers } from "./main";

export type HotBackend = ServerHandlers & {
  readonly dispose: () => Promise<void>;
};

export const createHotBackend = async (): Promise<HotBackend> => {
  const handlers = await createServerHandlers();

  return {
    ...handlers,
    dispose: async () => {
      await handlers.api.dispose().catch(() => undefined);
      await handlers.mcp.close().catch(() => undefined);
    },
  };
};
