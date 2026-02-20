import { Result } from "better-result";
import { z } from "zod";
import type { ActionCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { internal } from "../../convex/_generated/api";
import { sourceSignature } from "./tool_source_signature";

export const TOOL_REGISTRY_SIGNATURE_PREFIX = "toolreg_v6|";

export function registrySignatureForWorkspace(
  workspaceId: Id<"workspaces">,
  sources: Array<{ id: string; updatedAt: number; enabled: boolean }>,
): string {
  const enabledSources = sources.filter((source) => source.enabled);
  return `${TOOL_REGISTRY_SIGNATURE_PREFIX}${sourceSignature(workspaceId, enabledSources)}`;
}

const registryStateSchema = z.object({
  signature: z.string().optional(),
  sourceStates: z.array(z.object({
    sourceId: z.string(),
    signature: z.string(),
    state: z.union([
      z.literal("queued"),
      z.literal("loading"),
      z.literal("indexing"),
      z.literal("ready"),
      z.literal("failed"),
    ]),
  })).optional(),
});

type RegistryState = z.infer<typeof registryStateSchema> | null;

const toolSourceStateSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  scopeType: z.string().optional(),
  organizationId: z.string().optional(),
  workspaceId: z.string().optional(),
  specHash: z.string().optional(),
  authFingerprint: z.string().optional(),
  updatedAt: z.number(),
  enabled: z.boolean().optional(),
}).transform((source) => ({
  id: source.id,
  type: source.type,
  scopeType: source.scopeType,
  organizationId: source.organizationId,
  workspaceId: source.workspaceId,
  specHash: source.specHash,
  authFingerprint: source.authFingerprint,
  updatedAt: source.updatedAt,
  enabled: source.enabled !== false,
}));

type ToolSourceState = z.infer<typeof toolSourceStateSchema>;

const toolSourceStateListSchema = z.array(toolSourceStateSchema);

function toRegistryState(value: unknown): RegistryState {
  const parsed = registryStateSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

function toToolSourceStateList(value: unknown): ToolSourceState[] {
  const parsed = toolSourceStateListSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }

  return parsed.data;
}

async function readRegistryState(
  ctx: Pick<ActionCtx, "runQuery">,
  workspaceId: Id<"workspaces">,
): Promise<{ isReady: boolean }> {
  const [rawState, rawSources] = await Promise.all([
    ctx.runQuery(internal.toolRegistry.getState, { workspaceId }),
    ctx.runQuery(internal.database.listToolSources, { workspaceId }),
  ]);
  const state = toRegistryState(rawState);
  const sources = toToolSourceStateList(rawSources);

  const expectedSignature = registrySignatureForWorkspace(workspaceId, sources);
  const sourceStateById = new Map((state?.sourceStates ?? []).map((item) => [item.sourceId, item]));
  const hasPendingOrMismatchedSource = sources.some((source) => {
    if (source.enabled === false) {
      return false;
    }

    const sourceState = sourceStateById.get(source.id);
    const expectedSourceSignature = registrySignatureForWorkspace(workspaceId, [{
      id: source.id,
      updatedAt: source.updatedAt,
      enabled: source.enabled,
    }]);
    if (!sourceState) {
      return true;
    }
    if (sourceState.signature !== expectedSourceSignature) {
      return true;
    }
    return sourceState.state !== "ready";
  });

  return {
    isReady: Boolean(state?.signature === expectedSignature && !hasPendingOrMismatchedSource),
  };
}

export async function getRegistryReadyResult(
  ctx: Pick<ActionCtx, "runQuery">,
  args: {
    workspaceId: Id<"workspaces">;
  },
): Promise<Result<void, Error>> {
  const initial = await readRegistryState(ctx, args.workspaceId);
  if (initial.isReady) {
    return Result.ok(undefined);
  }

  return Result.err(
    new Error("Tool registry is not ready yet. Rebuild after changing sources or credentials."),
  );
}
