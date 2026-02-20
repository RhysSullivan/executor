import { internal } from "../../../convex/_generated/api";
import type { StorageInstanceRecord } from "../../../../core/src/types";
import { getStorageProvider } from "../storage_provider";
import {
  storageCloseInputSchema,
  storageCloseOutputSchema,
  storageDeleteInputSchema,
  storageDeleteOutputSchema,
  storageListInputSchema,
  storageListOutputSchema,
  storageOpenInputSchema,
  storageOpenOutputSchema,
} from "../storage_tool_contracts/storage";
import {
  openStorageInstanceForTask,
  saveTaskStorageDefault,
  trackTaskStorageAccess,
  type StorageToolHandlerArgs,
} from "./context";

export async function runStorageInstanceHandler(args: StorageToolHandlerArgs): Promise<unknown | undefined> {
  const {
    ctx,
    task,
    payload,
    normalizedToolPath,
  } = args;

  if (normalizedToolPath === "storage.open") {
    const parsed = storageOpenInputSchema.parse(payload);
    const instance = await openStorageInstanceForTask(ctx, task, parsed);
    await saveTaskStorageDefault(
      ctx,
      task,
      instance.scopeType,
      instance.id,
      true,
      parsed.instanceId ? "provided" : "opened",
    );
    return storageOpenOutputSchema.parse({ instance });
  }

  if (normalizedToolPath === "storage.list") {
    const parsed = storageListInputSchema.parse(payload);
    const instances = await ctx.runQuery(internal.database.listStorageInstances, {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      scopeType: parsed.scopeType,
      includeDeleted: parsed.includeDeleted,
    });

    return storageListOutputSchema.parse({
      instances,
      total: instances.length,
    });
  }

  if (normalizedToolPath === "storage.close") {
    const parsed = storageCloseInputSchema.parse(payload);
    const instance = await ctx.runMutation(internal.database.closeStorageInstance, {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      instanceId: parsed.instanceId,
    });

    await trackTaskStorageAccess(ctx, task, {
      instanceId: parsed.instanceId,
      scopeType: instance?.scopeType,
      accessType: "provided",
    });

    return storageCloseOutputSchema.parse({ instance });
  }

  if (normalizedToolPath === "storage.delete") {
    const parsed = storageDeleteInputSchema.parse(payload);
    const existing = await ctx.runQuery(internal.database.getStorageInstance, {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      instanceId: parsed.instanceId,
    }) as StorageInstanceRecord | null;

    if (existing) {
      const provider = getStorageProvider(existing.provider);
      try {
        await provider.deleteInstance(existing);
      } catch {
        // Continue marking the instance deleted even if backend cleanup fails.
      }
    }

    const instance = await ctx.runMutation(internal.database.deleteStorageInstance, {
      workspaceId: task.workspaceId,
      accountId: task.accountId,
      instanceId: parsed.instanceId,
    });

    await trackTaskStorageAccess(ctx, task, {
      instanceId: parsed.instanceId,
      scopeType: existing?.scopeType,
      accessType: "provided",
    });

    return storageDeleteOutputSchema.parse({ instance });
  }

  return undefined;
}
