import type { Doc } from "../../convex/_generated/dataModel.d.ts";
import { z } from "zod";
import { isRecord } from "../lib/object";
import { DEFAULT_TASK_TIMEOUT_MS } from "../task/constants";

const sourceAuthSchema = z.object({
  type: z.string().optional(),
  mode: z.enum(["workspace", "account", "organization", "static"]).optional(),
  header: z.string().optional(),
});

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeSourceAuthFingerprint(value: unknown): string {
  const parsedAuth = sourceAuthSchema.safeParse(value);
  const auth = parsedAuth.success ? parsedAuth.data : {};
  const type = (auth.type ?? "none").trim();
  const mode = auth.mode ?? "workspace";
  const header = (auth.header ?? "").trim().toLowerCase();
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
  const metadata = isRecord(doc.metadata) ? doc.metadata : {};
  return {
    id: doc.taskId,
    code: doc.code,
    runtimeId: doc.runtimeId,
    status: doc.status,
    timeoutMs: typeof doc.timeoutMs === "number" ? doc.timeoutMs : DEFAULT_TASK_TIMEOUT_MS,
    metadata,
    workspaceId: doc.workspaceId,
    accountId: doc.accountId,
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

export function mapPolicy(doc: {
  policyId: string;
  scopeType: "account" | "organization" | "workspace";
  organizationId: Doc<"organizations">["_id"];
  workspaceId?: Doc<"workspaces">["_id"];
  targetAccountId?: Doc<"accounts">["_id"];
  clientId?: string;
  resourceType: "all_tools" | "source" | "namespace" | "tool_path";
  resourcePattern: string;
  matchType: "glob" | "exact";
  effect: "allow" | "deny";
  approvalMode: "inherit" | "auto" | "required";
  argumentConditions?: Array<{
    key: string;
    operator: "equals" | "contains" | "starts_with" | "not_equals";
    value: string;
  }>;
  priority: number;
  createdAt: number;
  updatedAt: number;
  roleId?: string;
  ruleId?: string;
  bindingId?: string;
}) {
  return {
    id: doc.policyId,
    scopeType: doc.scopeType,
    organizationId: doc.organizationId,
    workspaceId: doc.workspaceId,
    targetAccountId: doc.targetAccountId,
    clientId: doc.clientId,
    resourceType: doc.resourceType,
    resourcePattern: doc.resourcePattern,
    matchType: doc.matchType,
    effect: doc.effect,
    approvalMode: doc.approvalMode,
    argumentConditions: doc.argumentConditions,
    priority: doc.priority,
    roleId: doc.roleId,
    ruleId: doc.ruleId,
    bindingId: doc.bindingId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function mapCredential(doc: Doc<"sourceCredentials">) {
  const secretJson = isRecord(doc.secretJson) ? doc.secretJson : {};
  const overridesJson = isRecord(doc.overridesJson) ? doc.overridesJson : {};
  return {
    id: doc.credentialId,
    bindingId: doc.bindingId,
    scopeType: doc.scopeType,
    accountId: doc.accountId,
    organizationId: doc.organizationId,
    workspaceId: doc.workspaceId,
    sourceKey: doc.sourceKey,
    provider: doc.provider,
    secretJson,
    overridesJson,
    boundAuthFingerprint: doc.boundAuthFingerprint,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function mapSource(doc: Doc<"toolSources">) {
  const config = isRecord(doc.config) ? doc.config : {};
  return {
    id: doc.sourceId,
    scopeType: doc.scopeType,
    organizationId: doc.organizationId,
    workspaceId: doc.workspaceId,
    name: doc.name,
    type: doc.type,
    config,
    specHash: doc.specHash,
    authFingerprint: doc.authFingerprint,
    enabled: Boolean(doc.enabled),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
