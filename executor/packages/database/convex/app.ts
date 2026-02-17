import { customQuery, optionalAccountQuery } from "../../core/src/function-builders";

const workosEnabled = Boolean(process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY);

export const getClientConfig = customQuery({
  method: "GET",
  args: {},
  handler: async () => {
    return {
      authProviderMode: workosEnabled ? "workos" : "local",
      invitesProvider: workosEnabled ? "workos" : "disabled",
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
