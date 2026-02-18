import { customQuery, optionalAccountQuery } from "../../core/src/function-builders";
import {
  CLOUDFLARE_WORKER_LOADER_RUNTIME_ID,
  LOCAL_BUN_RUNTIME_ID,
  defaultRuntimeId,
  isRuntimeEnabled,
} from "../../core/src/runtimes/runtime-catalog";

const workosEnabled = Boolean(process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY);

export const getClientConfig = customQuery({
  method: "GET",
  args: {},
  handler: async () => {
    const allowLocalVm = isRuntimeEnabled(LOCAL_BUN_RUNTIME_ID);
    const enabledRuntimeIds = [
      ...(allowLocalVm ? [LOCAL_BUN_RUNTIME_ID] : []),
      CLOUDFLARE_WORKER_LOADER_RUNTIME_ID,
    ];

    return {
      authProviderMode: workosEnabled ? "workos" : "local",
      invitesProvider: workosEnabled ? "workos" : "disabled",
      anonymousAuthIssuer: process.env.ANONYMOUS_AUTH_ISSUER ?? null,
      runtime: {
        allowLocalVm,
        defaultRuntimeId: defaultRuntimeId(),
        enabledRuntimeIds,
      },
      features: {
        organizations: true,
        billing: true,
        workspaceRestrictions: true,
      },
    };
  },
});

export const getCurrentAccount = optionalAccountQuery({
  method: "GET",
  args: {},
  handler: async (ctx) => ctx.account,
});
