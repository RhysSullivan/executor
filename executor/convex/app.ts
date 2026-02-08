import { query } from "./_generated/server";
import { optionalAccountQuery } from "./lib/functionBuilders";

const workosEnabled = Boolean(process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY);

export const getClientConfig = query({
  args: {},
  handler: async () => {
    return {
      authProviderMode: workosEnabled ? "workos" : "local",
      invitesProvider: workosEnabled ? "workos" : "disabled",
      features: {
        organizations: true,
        billing: true,
        workspaceRestrictions: false,
      },
    };
  },
});

export const getCurrentAccount = optionalAccountQuery({
  args: {},
  handler: async (ctx) => ctx.account,
});
