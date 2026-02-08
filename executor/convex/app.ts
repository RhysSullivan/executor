import { query } from "./_generated/server";

const workosEnabled = Boolean(process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY);

export const getClientConfig = query({
  args: {},
  handler: async () => {
    return {
      authProviderMode: workosEnabled ? "workos" : "local",
      invitesProvider: workosEnabled ? "workos" : "local",
      features: {
        organizations: true,
        billing: true,
        workspaceRestrictions: false,
      },
    };
  },
});
