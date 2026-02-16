import type { Doc } from "../../convex/_generated/dataModel.d.ts";
import type { QueryCtx } from "../../convex/_generated/server";
import { normalizeSourceAuthFingerprint } from "./mappers";
import { asRecord } from "../lib/object";

export function mapAnonymousContext(doc: Doc<"anonymousSessions">) {
  return {
    sessionId: doc.sessionId,
    workspaceId: doc.workspaceId,
    actorId: doc.actorId,
    clientId: doc.clientId,
    accountId: doc.accountId,
    userId: doc.userId,
    createdAt: doc.createdAt,
    lastSeenAt: doc.lastSeenAt,
  };
}

export function mapTaskEvent(doc: Doc<"taskEvents">) {
  return {
    id: doc.sequence,
    taskId: doc.taskId,
    eventName: doc.eventName,
    type: doc.type,
    payload: doc.payload,
    createdAt: doc.createdAt,
  };
}

export async function getTaskDoc(ctx: { db: QueryCtx["db"] }, taskId: string) {
  return await ctx.db.query("tasks").withIndex("by_task_id", (q) => q.eq("taskId", taskId)).unique();
}

export async function getApprovalDoc(ctx: { db: QueryCtx["db"] }, approvalId: string) {
  return await ctx.db
    .query("approvals")
    .withIndex("by_approval_id", (q) => q.eq("approvalId", approvalId))
    .unique();
}

export async function getToolCallDoc(
  ctx: { db: QueryCtx["db"] },
  taskId: string,
  callId: string,
) {
  return await ctx.db
    .query("toolCalls")
    .withIndex("by_task_call", (q) => q.eq("taskId", taskId).eq("callId", callId))
    .unique();
}

export async function computeBoundAuthFingerprint(
  ctx: Pick<QueryCtx, "db">,
  workspaceId: Doc<"workspaces">["_id"],
  sourceKey: string,
): Promise<string> {
  const prefix = "source:";
  if (!sourceKey.startsWith(prefix)) {
    return normalizeSourceAuthFingerprint({ type: "none" });
  }

  const sourceId = sourceKey.slice(prefix.length).trim();
  if (!sourceId) {
    return normalizeSourceAuthFingerprint({ type: "none" });
  }

  const source = await ctx.db
    .query("toolSources")
    .withIndex("by_source_id", (q) => q.eq("sourceId", sourceId))
    .unique();

  if (!source || source.workspaceId !== workspaceId) {
    return normalizeSourceAuthFingerprint({ type: "none" });
  }

  return normalizeSourceAuthFingerprint(asRecord(source.config).auth);
}
