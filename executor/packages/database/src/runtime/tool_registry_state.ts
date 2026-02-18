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

type RegistryState = {
  signature?: string;
  readyBuildId?: string;
  buildingBuildId?: string;
} | null;

const registryStateSchema = z.object({
  signature: z.string().optional(),
  readyBuildId: z.string().optional(),
  buildingBuildId: z.string().optional(),
});

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

  return {
    signature: parsed.data.signature,
    readyBuildId: parsed.data.readyBuildId,
    buildingBuildId: parsed.data.buildingBuildId,
  };
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
): Promise<{ buildId?: string; isReady: boolean }> {
  const [rawState, rawSources] = await Promise.all([
    ctx.runQuery(internal.toolRegistry.getState, { workspaceId }),
    ctx.runQuery(internal.database.listToolSources, { workspaceId }),
  ]);
  const state = toRegistryState(rawState);
  const sources = toToolSourceStateList(rawSources);

  const expectedSignature = registrySignatureForWorkspace(workspaceId, sources);
  const buildId = state?.readyBuildId;

  return {
    buildId,
    isReady: Boolean(buildId && !state?.buildingBuildId && state?.signature === expectedSignature),
  };
}

export async function getReadyRegistryBuildIdResult(
  ctx: Pick<ActionCtx, "runQuery" | "runAction">,
  args: {
    workspaceId: Id<"workspaces">;
    accountId?: Id<"accounts">;
    clientId?: string;
  },
): Promise<Result<string, Error>> {
  const initial = await readRegistryState(ctx, args.workspaceId);
  if (initial.isReady && initial.buildId) {
    return Result.ok(initial.buildId);
  }

  return Result.err(
    new Error("Tool registry is not ready (or is stale). Rebuild after changing sources or credentials."),
  );
}

export async function getReadyRegistryBuildId(
  ctx: Pick<ActionCtx, "runQuery" | "runAction">,
  args: {
    workspaceId: Id<"workspaces">;
    accountId?: Id<"accounts">;
    clientId?: string;
  },
): Promise<string> {
  const buildIdResult = await getReadyRegistryBuildIdResult(ctx, args);
  if (buildIdResult.isErr()) {
    throw buildIdResult.error;
  }

  return buildIdResult.value;
}
