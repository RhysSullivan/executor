import { Migrations } from "@convex-dev/migrations";
import type { DataModel } from "./_generated/dataModel.d.ts";
import { components } from "./_generated/api";

const migrations = new Migrations<DataModel>(components.migrations);

export const deleteAnonymousSessionsMissingAccountId = migrations.define({
  table: "anonymousSessions",
  migrateOne: async (ctx, session) => {
    if (session.accountId) {
      return;
    }

    await ctx.db.delete(session._id);
  },
});

export const deleteSourceCredentialsMissingProvider = migrations.define({
  table: "sourceCredentials",
  migrateOne: async (ctx, credential) => {
    if (credential.provider) {
      return;
    }

    await ctx.db.delete(credential._id);
  },
});

export const cleanupTaskEmptyStringSentinels = migrations.define({
  table: "tasks",
  migrateOne: async (_ctx, task) => {
    const patch: Record<string, undefined> = {};
    if (Reflect.get(task, "accountId") === "") patch.accountId = undefined;
    if (task.clientId === "") patch.clientId = undefined;
    if (Object.keys(patch).length > 0) return patch;
  },
});

export const cleanupAccessPolicyEmptyStringSentinels = migrations.define({
  table: "accessPolicies",
  migrateOne: async (_ctx, policy) => {
    const policyRecord = policy as Record<string, unknown>;
    const patch: Record<string, undefined> = {};
    if (Reflect.get(policyRecord, "accountId") === "") patch["accountId"] = undefined;
    if (Reflect.get(policyRecord, "targetAccountId") === "") patch["targetAccountId"] = undefined;
    if (policy.clientId === "") patch["clientId"] = undefined;
    if (Object.keys(patch).length > 0) return patch;
  },
});

export const run = migrations.runner();
