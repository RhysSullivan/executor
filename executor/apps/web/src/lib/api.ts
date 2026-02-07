// Thin API client that calls through the Next.js rewrite proxy (/api/* -> backend)

import type {
  AnonymousContext,
  TaskRecord,
  CreateTaskRequest,
  CreateTaskResponse,
  ApprovalRecord,
  PendingApprovalRecord,
  ResolveApprovalRequest,
  RuntimeTargetDescriptor,
  ToolDescriptor,
  ToolSourceRecord,
  AccessPolicyRecord,
  CredentialDescriptor,
  TaskEventRecord,
} from "./types";

const BASE = "";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Auth ──

export async function bootstrapAnonymousContext(
  sessionId?: string,
): Promise<AnonymousContext> {
  const res = await fetch(`${BASE}/api/auth/anonymous/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  return json<AnonymousContext>(res);
}

// ── Tasks ──

export async function createTask(
  request: CreateTaskRequest,
): Promise<CreateTaskResponse> {
  const res = await fetch(`${BASE}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return json<CreateTaskResponse>(res);
}

export async function listTasks(workspaceId: string): Promise<TaskRecord[]> {
  const res = await fetch(
    `${BASE}/api/tasks?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return json<TaskRecord[]>(res);
}

export async function getTask(
  taskId: string,
  workspaceId: string,
): Promise<TaskRecord> {
  const res = await fetch(
    `${BASE}/api/tasks/${encodeURIComponent(taskId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return json<TaskRecord>(res);
}

// ── Approvals ──

export async function listPendingApprovals(
  workspaceId: string,
): Promise<PendingApprovalRecord[]> {
  const res = await fetch(
    `${BASE}/api/approvals?workspaceId=${encodeURIComponent(workspaceId)}&status=pending`,
  );
  return json<PendingApprovalRecord[]>(res);
}

export async function listApprovals(
  workspaceId: string,
  status?: string,
): Promise<ApprovalRecord[]> {
  const params = new URLSearchParams({ workspaceId });
  if (status) params.set("status", status);
  const res = await fetch(`${BASE}/api/approvals?${params.toString()}`);
  return json<ApprovalRecord[]>(res);
}

export async function resolveApproval(
  approvalId: string,
  request: ResolveApprovalRequest,
): Promise<{ approval: ApprovalRecord; task: TaskRecord }> {
  const res = await fetch(
    `${BASE}/api/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  return json<{ approval: ApprovalRecord; task: TaskRecord }>(res);
}

// ── Runtimes ──

export async function listRuntimeTargets(): Promise<
  RuntimeTargetDescriptor[]
> {
  const res = await fetch(`${BASE}/api/runtime-targets`);
  return json<RuntimeTargetDescriptor[]>(res);
}

// ── Tools ──

export async function listToolsForContext(context: {
  workspaceId: string;
  actorId?: string;
  clientId?: string;
}): Promise<ToolDescriptor[]> {
  const params = new URLSearchParams({ workspaceId: context.workspaceId });
  if (context.actorId) params.set("actorId", context.actorId);
  if (context.clientId) params.set("clientId", context.clientId);
  const res = await fetch(`${BASE}/api/tools?${params.toString()}`);
  return json<ToolDescriptor[]>(res);
}

// ── Tool Sources ──

export async function listToolSources(
  workspaceId: string,
): Promise<ToolSourceRecord[]> {
  const res = await fetch(
    `${BASE}/api/tool-sources?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return json<ToolSourceRecord[]>(res);
}

export async function upsertToolSource(request: {
  id?: string;
  workspaceId: string;
  name: string;
  type: "mcp" | "openapi";
  config: Record<string, unknown>;
  enabled?: boolean;
}): Promise<ToolSourceRecord> {
  const res = await fetch(`${BASE}/api/tool-sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return json<ToolSourceRecord>(res);
}

export async function deleteToolSource(
  workspaceId: string,
  sourceId: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    `${BASE}/api/tool-sources/${encodeURIComponent(sourceId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    { method: "DELETE" },
  );
  return json<{ ok: boolean }>(res);
}

// ── Policies ──

export async function listPolicies(
  workspaceId: string,
): Promise<AccessPolicyRecord[]> {
  const res = await fetch(
    `${BASE}/api/policies?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return json<AccessPolicyRecord[]>(res);
}

export async function upsertPolicy(request: {
  id?: string;
  workspaceId: string;
  actorId?: string;
  clientId?: string;
  toolPathPattern: string;
  decision: string;
  priority?: number;
}): Promise<AccessPolicyRecord> {
  const res = await fetch(`${BASE}/api/policies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return json<AccessPolicyRecord>(res);
}

// ── Credentials ──

export async function listCredentials(
  workspaceId: string,
): Promise<CredentialDescriptor[]> {
  const res = await fetch(
    `${BASE}/api/credentials?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return json<CredentialDescriptor[]>(res);
}

export async function upsertCredential(request: {
  id?: string;
  workspaceId: string;
  sourceKey: string;
  scope: string;
  actorId?: string;
  secretJson: Record<string, unknown>;
}): Promise<CredentialDescriptor> {
  const res = await fetch(`${BASE}/api/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return json<CredentialDescriptor>(res);
}

// ── SSE ──

export function subscribeToTaskEvents(
  taskId: string,
  workspaceId: string,
  onEvent: (
    eventName: TaskEventRecord["eventName"],
    event: TaskEventRecord,
  ) => void,
): EventSource {
  const source = new EventSource(
    `${BASE}/api/tasks/${encodeURIComponent(taskId)}/events?workspaceId=${encodeURIComponent(workspaceId)}`,
  );

  source.addEventListener("task", (event) => {
    const message = event as MessageEvent<string>;
    onEvent("task", JSON.parse(message.data) as TaskEventRecord);
  });

  source.addEventListener("approval", (event) => {
    const message = event as MessageEvent<string>;
    onEvent("approval", JSON.parse(message.data) as TaskEventRecord);
  });

  return source;
}
