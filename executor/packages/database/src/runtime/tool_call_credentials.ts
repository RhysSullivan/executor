import { Result } from "better-result";
import type { ActionCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import { resolveCredentialPayloadResult } from "../../../core/src/credential-providers";
import {
  buildCredentialAuthHeaders,
  readCredentialAdditionalHeaders,
} from "../../../core/src/tool/source-auth";
import type { ResolvedToolCredential, TaskRecord, ToolCallRecord, ToolCredentialSpec } from "../../../core/src/types";
import { ToolCallControlError } from "../../../core/src/tool-call-control";
import { readWorkosVaultObjectViaAction } from "./workos_vault_reader";

export async function resolveCredentialHeadersResult(
  ctx: Pick<ActionCtx, "runQuery" | "runAction">,
  spec: ToolCredentialSpec,
  task: TaskRecord,
): Promise<Result<ResolvedToolCredential | null, Error>> {
  const record = await ctx.runQuery(internal.database.resolveCredential, {
    workspaceId: task.workspaceId,
    sourceKey: spec.sourceKey,
    scopeType: spec.mode,
    accountId: task.accountId,
  });

  const sourceResult = record
    ? await resolveCredentialPayloadResult(record, {
      readVaultObject: async (input) => await readWorkosVaultObjectViaAction(ctx, input),
    })
    : Result.ok(null);
  if (sourceResult.isErr()) {
    return Result.err(
      new Error(`Failed to resolve credential payload for '${spec.sourceKey}': ${sourceResult.error.message}`),
    );
  }

  const source = sourceResult.value;
  if (!source) {
    return Result.ok(null);
  }

  const headers = buildCredentialAuthHeaders(
    {
      authType: spec.authType,
      headerName: spec.headerName,
    },
    source,
  );

  const additionalHeaders = readCredentialAdditionalHeaders(record?.additionalHeaders);
  for (const [key, value] of Object.entries(additionalHeaders)) {
    headers[key] = value;
  }

  if (Object.keys(headers).length === 0) {
    return Result.ok(null);
  }

  return Result.ok({
    sourceKey: spec.sourceKey,
    mode: spec.mode,
    headers,
  });
}

export async function resolveCredentialHeaders(
  ctx: Pick<ActionCtx, "runQuery" | "runAction">,
  spec: ToolCredentialSpec,
  task: TaskRecord,
): Promise<ResolvedToolCredential | null> {
  const result = await resolveCredentialHeadersResult(ctx, spec, task);
  if (result.isErr()) {
    throw result.error;
  }

  return result.value;
}

export function validatePersistedCallRunnable(
  persistedCall: ToolCallRecord,
  callId: string,
): Result<void, Error> {
  if (persistedCall.status === "completed") {
    return Result.err(new Error(`Tool call ${callId} already completed; output is not retained`));
  }

  if (persistedCall.status === "failed") {
    return Result.err(new Error(persistedCall.error ?? `Tool call failed: ${callId}`));
  }

  if (persistedCall.status === "denied") {
    return Result.err(
      new ToolCallControlError({
        kind: "approval_denied",
        reason: persistedCall.error ?? persistedCall.toolPath,
      }),
    );
  }

  return Result.ok(undefined);
}
