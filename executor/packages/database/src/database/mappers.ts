import type { Doc } from "../../convex/_generated/dataModel.d.ts";
import { asRecord } from "../lib/object";
import { DEFAULT_TASK_TIMEOUT_MS } from "../task/constants";

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeSourceAuthFingerprint(value: unknown): string {
  const auth = asRecord(value);
  const type = typeof auth.type === "string" ? auth.type.trim() : "none";
  const mode = auth.mode === "actor" ? "actor" : "workspace";
  const header = typeof auth.header === "string" ? auth.header.trim().toLowerCase() : "";
  return stableStringify({
    type: type || "none",
    mode,
    ...(header ? { header } : {}),
  });
}

export function computeSourceSpecHash(type: "mcp" | "openapi" | "graphql", config: Record<string, unknown>): string {
  if (type === "openapi") {
    const spec = config.spec;
    if (typeof spec === "string") {
      return `openapi:${spec.trim()}`;
    }
    return `openapi:${stableStringify(spec)}`;
  }
  if (type === "graphql") {
    const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
    return `graphql:${endpoint}`;
  }
  const url = typeof config.url === "string" ? config.url.trim() : "";
  return `mcp:${url}`;
}

export function mapTask(doc: Doc<"tasks">) {
  return {
    id: doc.taskId,
    code: doc.code,
    runtimeId: doc.runtimeId,
    status: doc.status,
    timeoutMs: typeof doc.timeoutMs === "number" ? doc.timeoutMs : DEFAULT_TASK_TIMEOUT_MS,
    metadata: asRecord(doc.metadata),
    workspaceId: doc.workspaceId,
    actorId: doc.actorId,
    clientId: doc.clientId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    error: doc.error,
    exitCode: doc.exitCode,
  };
}

export function mapApproval(doc: Doc<"approvals">) {
  return {
    id: doc.approvalId,
    taskId: doc.taskId,
    toolPath: doc.toolPath,
    input: doc.input,
    status: doc.status,
    reason: doc.reason,
    reviewerId: doc.reviewerId,
    createdAt: doc.createdAt,
    resolvedAt: doc.resolvedAt,
  };
}

export function mapToolCall(doc: Doc<"toolCalls">) {
  return {
    taskId: doc.taskId,
    callId: doc.callId,
    workspaceId: doc.workspaceId,
    toolPath: doc.toolPath,
    status: doc.status,
    approvalId: doc.approvalId,
    error: doc.error,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    completedAt: doc.completedAt,
  };
}

export function mapPolicy(doc: Doc<"accessPolicies">) {
  return {
    id: doc.policyId,
    workspaceId: doc.workspaceId,
    actorId: doc.actorId,
    clientId: doc.clientId,
    toolPathPattern: doc.toolPathPattern,
    decision: doc.decision,
    priority: doc.priority,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function mapCredential(doc: Doc<"sourceCredentials">) {
  return {
    id: doc.credentialId,
    bindingId: doc.bindingId,
    workspaceId: doc.workspaceId,
    sourceKey: doc.sourceKey,
    scope: doc.scope,
    actorId: doc.actorId || undefined,
    provider: doc.provider,
    secretJson: asRecord(doc.secretJson),
    overridesJson: asRecord(doc.overridesJson),
    boundAuthFingerprint: doc.boundAuthFingerprint,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function mapSource(doc: Doc<"toolSources">) {
  return {
    id: doc.sourceId,
    workspaceId: doc.workspaceId,
    name: doc.name,
    type: doc.type,
    config: asRecord(doc.config),
    specHash: doc.specHash,
    authFingerprint: doc.authFingerprint,
    enabled: Boolean(doc.enabled),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
