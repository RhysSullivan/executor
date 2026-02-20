import { AuthKit, type AuthFunctions } from "@convex-dev/workos-authkit";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel.d.ts";
import { internalMutation } from "./_generated/server";
import { customMutation } from "../../core/src/function-builders";
import { bootstrapCurrentWorkosAccountImpl } from "../src/auth/bootstrap";
import { workosEventHandlers } from "../src/auth/event_handlers";

const workosEnabled = Boolean(
  process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY && process.env.WORKOS_WEBHOOK_SECRET,
);

const authFunctions = (internal as Record<string, unknown>).auth as AuthFunctions;
const workosComponent = (components as Record<string, unknown>).workOSAuthKit;

const authKitInstance = workosEnabled
  ? new AuthKit<DataModel>(workosComponent as never, {
      authFunctions,
      additionalEventTypes: [
        "organization.created",
        "organization.updated",
        "organization.deleted",
        "organization_membership.created",
        "organization_membership.updated",
        "organization_membership.deleted",
      ],
    })
  : null;

export const authKit =
  authKitInstance ??
  ({
    registerRoutes: () => {},
  } as Pick<AuthKit<DataModel>, "registerRoutes">);

const authKitEvents = workosEnabled && authKitInstance ? authKitInstance.events(workosEventHandlers) : null;

export const authKitEvent = authKitEvents?.authKitEvent ?? internalMutation({
  args: {},
  handler: async () => null,
});

export const bootstrapCurrentWorkosAccount = customMutation({
  method: "POST",
  args: {
    sessionId: v.optional(v.string()),
    profileName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await bootstrapCurrentWorkosAccountImpl(ctx, args);
  },
});
