/**
 * TaskMessage — self-contained live-updating Discord message for a task.
 *
 * Subscribes to the server's SSE stream via Eden Treaty on mount,
 * reduces TaskEvents into local state, and re-renders reactively.
 *
 * The command handler just mounts this component and walks away:
 *   <TaskMessage taskId={id} prompt={prompt} api={api} />
 */

import { useState, useEffect } from "react";
import {
  Container,
  TextDisplay,
  Separator,
  ActionRow,
  Button,
  ModalButton,
  Loading,
  useInstance,
  type ModalField,
  type ModalFieldValues,
} from "@openassistant/reacord";
import type { Client as ApiClient } from "@openassistant/server/client";
import { unwrap } from "@openassistant/server/client";
import type { TaskEvent } from "@openassistant/core/events";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface PendingApproval {
  readonly id: string;
  readonly toolPath: string;
  readonly input: unknown;
  readonly preview: { title: string; details?: string; link?: string };
}

interface TaskState {
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly statusMessage: string;
  readonly lastCode: string | null;
  readonly toolResults: string[];
  readonly pendingApprovals: PendingApproval[];
  readonly agentMessage: string | null;
  readonly error: string | null;
  /** Whether an approval rule has been created for this task. */
  readonly hasRule: boolean;
}

const INITIAL_STATE: TaskState = {
  status: "running",
  statusMessage: "Thinking...",
  lastCode: null,
  toolResults: [],
  pendingApprovals: [],
  agentMessage: null,
  error: null,
  hasRule: false,
};

function reduceEvent(state: TaskState, event: TaskEvent): TaskState {
  switch (event.type) {
    case "status":
      return { ...state, statusMessage: event.message };

    case "code_generated":
      return { ...state, lastCode: event.code, statusMessage: "Running code..." };

    case "approval_request":
      return {
        ...state,
        pendingApprovals: [
          ...state.pendingApprovals,
          { id: event.id, toolPath: event.toolPath, input: event.input, preview: event.preview },
        ],
        statusMessage: "Waiting for approval...",
      };

    case "approval_resolved":
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter((a) => a.id !== event.id),
        statusMessage: event.decision === "approved" ? "Approved, continuing..." : "Denied.",
      };

    case "tool_result": {
      const r = event.receipt;
      const icon = r.status === "succeeded" ? "\u2705" : r.status === "denied" ? "\u26d4" : "\u274c";
      const shortName = formatToolName(r.toolPath);
      const output = formatToolOutput(r.toolPath, r.outputPreview);
      const line = `${icon} ${shortName}${output}`;
      return { ...state, toolResults: [...state.toolResults, line] };
    }

    case "agent_message":
      return { ...state, agentMessage: event.text, statusMessage: "Done" };

    case "error":
      return { ...state, status: "failed", error: event.error, statusMessage: "Failed" };

    case "completed":
      return { ...state, status: "completed", statusMessage: "Completed" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TaskMessageProps {
  readonly taskId: string;
  readonly prompt: string;
  readonly api: ApiClient;
}

export function TaskMessage({ taskId, prompt, api }: TaskMessageProps) {
  const instance = useInstance();
  const [state, setState] = useState<TaskState>(INITIAL_STATE);

  // Subscribe to SSE stream on mount
  useEffect(() => {
    let cancelled = false;

    const subscribe = async () => {
      try {
        const { data: stream, error } = await api.api.tasks({ id: taskId }).events.get();

        if (error || !stream) {
          if (!cancelled) {
            setState((s) => ({ ...s, status: "failed", error: "Failed to connect to event stream", statusMessage: "Failed" }));
          }
          return;
        }

        for await (const sse of stream as AsyncIterable<{ event: string; data: TaskEvent }>) {
          if (cancelled) break;
          setState((s) => reduceEvent(s, sse.data));
        }
      } catch (err) {
        if (!cancelled) {
          setState((s) => ({
            ...s,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            statusMessage: "Failed",
          }));
        }
      }
    };

    subscribe();

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // Deactivate buttons once done
  useEffect(() => {
    if (state.status !== "running") {
      const timer = setTimeout(() => instance.deactivate(), 5000);
      return () => clearTimeout(timer);
    }
  }, [state.status]);

  const isDone = state.status !== "running";
  const accentColor = isDone
    ? state.status === "completed" ? 0x57f287 : 0xed4245
    : 0x5865f2;

  return (
    <Container accentColor={accentColor}>
      <TextDisplay>{`${statusEmoji(state.status)} **${state.statusMessage}**`}</TextDisplay>
      <TextDisplay>{`> ${prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt}`}</TextDisplay>

      {state.lastCode && (
        <>
          <Separator />
          <TextDisplay>{`\`\`\`ts\n${state.lastCode.length > 800 ? state.lastCode.slice(0, 800) + "\n// ..." : state.lastCode}\n\`\`\``}</TextDisplay>
        </>
      )}

      {state.toolResults.length > 0 && (
        <>
          <Separator />
          <TextDisplay>{collapseToolResults(state.toolResults, 10).join("\n")}</TextDisplay>
        </>
      )}

      {state.pendingApprovals.map((approval) => (
        <ApprovalButtons
          key={approval.id}
          approval={approval}
          api={api}
          taskId={taskId}
          hasRule={state.hasRule}
          onRuleCreated={() => setState((s) => ({ ...s, hasRule: true }))}
        />
      ))}

      {state.error && (
        <>
          <Separator />
          <TextDisplay>{`\u274c **Error:** ${state.error.slice(0, 500)}`}</TextDisplay>
        </>
      )}

      {state.agentMessage && (
        <>
          <Separator />
          <TextDisplay>
            {state.agentMessage.length > 1800
              ? state.agentMessage.slice(0, 1800) + "..."
              : state.agentMessage}
          </TextDisplay>
        </>
      )}

      {state.status === "running" && state.pendingApprovals.length === 0 && (
        <Loading />
      )}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Approval buttons
// ---------------------------------------------------------------------------

function ApprovalButtons({
  approval,
  api,
  taskId,
  hasRule,
  onRuleCreated,
}: {
  approval: PendingApproval;
  api: ApiClient;
  taskId: string;
  hasRule: boolean;
  onRuleCreated: () => void;
}) {
  const [resolved, setResolved] = useState(false);
  const argsPreview = formatApprovalInput(approval.input);

  const handle = async (decision: "approved" | "denied") => {
    setResolved(true);
    try {
      await unwrap(api.api.approvals({ callId: approval.id }).post({ decision }));
    } catch (err) {
      console.error(`[approval ${approval.id}]`, err);
    }
  };

  // Extract field names from the input for the rule builder
  const inputFields = extractFieldNames(approval.input);

  const ruleFields: ModalField[] = [
    {
      type: "stringSelect",
      id: "field",
      label: "Field",
      description: "Which input field to check",
      placeholder: "Select a field...",
      required: true,
      options: inputFields.map((f) => ({
        label: f.name,
        value: f.path,
        description: f.preview ? `Current: ${f.preview}` : undefined,
      })),
    },
    {
      type: "stringSelect",
      id: "operator",
      label: "Condition",
      description: "How to compare the field value",
      required: true,
      options: [
        { label: "equals", value: "equals" },
        { label: "does not equal", value: "not_equals" },
        { label: "includes", value: "includes" },
        { label: "does not include", value: "not_includes" },
      ],
    },
    {
      type: "textInput",
      id: "value",
      label: "Value",
      description: "Value to compare against",
      placeholder: "e.g. rhys.dev",
      style: "short",
      required: true,
    },
    {
      type: "stringSelect",
      id: "decision",
      label: "Action",
      description: "What to do when the rule matches",
      required: true,
      options: [
        { label: "Approve matching", value: "approved" },
        { label: "Deny matching", value: "denied" },
      ],
    },
  ];

  const handleRuleSubmit = async (values: ModalFieldValues) => {
    const field = values.getStringSelect("field")?.[0];
    const operator = values.getStringSelect("operator")?.[0];
    const value = values.getTextInput("value");
    const decision = values.getStringSelect("decision")?.[0];

    if (!field || !operator || value === undefined || !decision) return;

    try {
      await unwrap(
        api.api.tasks({ id: taskId })["approval-rules"].post({
          toolPath: approval.toolPath,
          field,
          operator: operator as "equals" | "not_equals" | "includes" | "not_includes",
          value,
          decision: decision as "approved" | "denied",
        }),
      );
      onRuleCreated();
    } catch (err) {
      console.error(`[rule creation]`, err);
    }
  };

  return (
    <>
      <Separator />
      <TextDisplay>
        {`\u{1f6e1}\ufe0f **Approval required:** ${approval.preview.title}${approval.preview.details ? `\n${approval.preview.details}` : ""}${approval.preview.link ? `\n${approval.preview.link}` : ""}`}
      </TextDisplay>
      {!resolved && (
        <ActionRow>
          <Button label="Approve" style="success" onClick={() => handle("approved")} />
          <Button label="Deny" style="danger" onClick={() => handle("denied")} />
          {!hasRule && inputFields.length > 0 && (
            <ModalButton
              label="Create Rule"
              style="secondary"
              modalTitle="Auto-approve/deny rule"
              fields={ruleFields}
              onSubmit={handleRuleSubmit}
            />
          )}
        </ActionRow>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Field extraction for rule builder
// ---------------------------------------------------------------------------

interface FieldInfo {
  readonly name: string;
  readonly path: string;
  readonly preview?: string;
}

function extractFieldNames(input: unknown, prefix = ""): FieldInfo[] {
  if (!input || typeof input !== "object") return [];
  const fields: FieldInfo[] = [];

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // Recurse into nested objects
      fields.push(...extractFieldNames(value, path));
    } else {
      const preview = value === undefined ? undefined : String(value).slice(0, 50);
      fields.push({ name: path, path, preview });
    }
  }

  return fields.slice(0, 25); // Discord select max 25 options
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusEmoji(status: TaskState["status"]): string {
  switch (status) {
    case "running": return "\u23f3";
    case "completed": return "\u2705";
    case "failed": return "\u274c";
    case "cancelled": return "\u26d4";
  }
}

/**
 * Shorten a tool path for display.
 * "github.issues.issues_list_for_repo" → "issues_list_for_repo"
 * "discover" → "discover"
 */
function formatToolName(toolPath: string): string {
  const parts = toolPath.split(".");
  return `\`${parts[parts.length - 1]}\``;
}

/**
 * Format tool output for display. Special-cases discover results
 * and truncates raw JSON.
 */
function formatToolOutput(toolPath: string, outputPreview: string | undefined): string {
  if (!outputPreview) return "";

  // Special-case discover results
  if (toolPath === "discover" || toolPath.endsWith(".discover")) {
    try {
      const parsed = JSON.parse(outputPreview.endsWith("...") ? outputPreview.slice(0, -3) + "}" : outputPreview);
      if (parsed.total !== undefined) {
        return ` \u2192 found ${parsed.total} tools`;
      }
    } catch { /* fall through */ }
  }

  // For other results, show a short preview
  const clean = outputPreview.length > 80 ? outputPreview.slice(0, 80) + "..." : outputPreview;
  return ` \u2192 ${clean}`;
}

/**
 * Collapse consecutive identical tool results into counts.
 * ["✅ `delete` → ...", "✅ `delete` → ...", "✅ `delete` → ..."]
 * becomes ["✅ `delete` ×3"]
 */
function collapseToolResults(results: string[], maxLines: number): string[] {
  if (results.length === 0) return [];

  const collapsed: string[] = [];
  let lastBase = "";
  let count = 0;

  for (const line of results) {
    // Extract the tool name part (icon + name)
    const base = line.replace(/ \u2192 .*$/, "");
    if (base === lastBase) {
      count++;
    } else {
      if (lastBase && count > 0) {
        collapsed.push(count === 1 ? results[collapsed.length] || lastBase : `${lastBase} \u00d7${count}`);
      }
      lastBase = base;
      count = 1;
    }
  }
  // Push the last group
  if (lastBase && count > 0) {
    if (count === 1) {
      collapsed.push(results[results.length - 1]!);
    } else {
      collapsed.push(`${lastBase} \u00d7${count}`);
    }
  }

  return collapsed.slice(-maxLines);
}

function formatApprovalInput(input: unknown): string {
  if (input === undefined) return "undefined";
  if (input === null) return "null";
  try {
    const serialized = JSON.stringify(input, null, 2);
    if (!serialized) return String(input);
    return serialized.length > 1000 ? `${serialized.slice(0, 1000)}...` : serialized;
  } catch {
    return String(input);
  }
}
