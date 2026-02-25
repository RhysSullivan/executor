import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type ApprovalStatus = "pending" | "approved" | "denied";

interface ApprovalRecord {
  id: string;
  action: string;
  justification: string;
  createdAt: number;
  status: ApprovalStatus;
  decidedAt: number | null;
}

interface PersistedState {
  approvals: ApprovalRecord[];
}

const HOME_DIR = process.env.HOME ?? ".";
const DATA_DIR = path.join(HOME_DIR, ".executor-lite-approvals");
const STATE_PATH = path.join(DATA_DIR, "mcp-state.json");
const APPROVAL_UI_SCRIPT = path.resolve(import.meta.dir, "approval-client.ts");

mkdirSync(DATA_DIR, { recursive: true });

const state: PersistedState = loadState();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function loadState(): PersistedState {
  if (!existsSync(STATE_PATH)) {
    return { approvals: [] };
  }

  try {
    const text = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(text) as Partial<PersistedState>;
    if (!parsed || !Array.isArray(parsed.approvals)) {
      return { approvals: [] };
    }

    return {
      approvals: parsed.approvals.filter((entry): entry is ApprovalRecord => {
        return (
          Boolean(entry) &&
          typeof entry.id === "string" &&
          typeof entry.action === "string" &&
          typeof entry.justification === "string" &&
          typeof entry.createdAt === "number" &&
          (entry.status === "pending" || entry.status === "approved" || entry.status === "denied")
        );
      }),
    };
  } catch {
    return { approvals: [] };
  }
}

function refreshStateFromDisk(): void {
  const disk = loadState();
  state.approvals = disk.approvals;
}

function saveState(): void {
  const tempPath = `${STATE_PATH}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2));
  renameSync(tempPath, STATE_PATH);
}

function recordPendingApproval(action: string, justification: string): ApprovalRecord {
  const entry: ApprovalRecord = {
    id: `appr_${crypto.randomUUID().slice(0, 8)}`,
    action,
    justification,
    createdAt: Date.now(),
    status: "pending",
    decidedAt: null,
  };

  state.approvals = [entry];
  saveState();
  return entry;
}

function removeApproval(approvalId: string): void {
  state.approvals = state.approvals.filter((item) => item.id !== approvalId);
  saveState();
}

function markDeniedIfStillPending(approvalId: string): void {
  const item = state.approvals.find((entry) => entry.id === approvalId);
  if (!item || item.status !== "pending") return;
  item.status = "denied";
  item.decidedAt = Date.now();
  saveState();
}

function maybeOpenApprovalPane(approvalId: string): void {
  if (!process.env.TMUX) return;

  const command = `bun run ${shellQuote(APPROVAL_UI_SCRIPT)} --inline --session claude --approval-id ${shellQuote(approvalId)}`;

  const split = Bun.spawnSync({
    cmd: ["tmux", "split-window", "-v", "-p", "30", command],
    stdin: "inherit",
    stdout: "ignore",
    stderr: "ignore",
  });

  if (split.exitCode !== 0) return;

  Bun.spawnSync({
    cmd: ["tmux", "select-pane", "-T", "Approvals"],
    stdin: "inherit",
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitForDecision(approvalId: string, timeoutMs: number): Promise<ApprovalStatus | "timeout"> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    refreshStateFromDisk();
    const current = state.approvals.find((entry) => entry.id === approvalId);
    if (current && current.status !== "pending") {
      return current.status;
    }

    await Bun.sleep(350);
  }

  return "timeout";
}

const mcp = new McpServer(
  { name: "memory-approval-demo", version: "0.0.1" },
  {
    capabilities: {
      tools: {},
    },
  },
);

mcp.registerTool(
  "dangerous_action",
  {
    description: "Queues a dangerous action and waits for sidecar approval from shared state.",
    inputSchema: {
      action: z.string().min(1),
      justification: z.string().optional(),
      approvalTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    },
  },
  async ({ action, justification, approvalTimeoutMs }) => {
    refreshStateFromDisk();
    const pending = recordPendingApproval(action, justification ?? "");
    maybeOpenApprovalPane(pending.id);

    const timeoutMs = approvalTimeoutMs ?? 120_000;
    const decision = await waitForDecision(pending.id, timeoutMs);

    refreshStateFromDisk();
    const current = state.approvals.find((item) => item.id === pending.id);

    if (decision === "approved" && current?.status === "approved") {
      removeApproval(pending.id);
      return {
        content: [{ type: "text", text: `Approved and executed '${action}'.` }],
        structuredContent: {
          approvalId: pending.id,
          status: "approved",
          action,
          executed: true,
        },
      };
    }

    if (decision === "timeout") {
      markDeniedIfStillPending(pending.id);
    }

    removeApproval(pending.id);

    return {
      content: [{ type: "text", text: `Denied '${action}' (${decision === "timeout" ? "approval timed out" : "approval denied"}).` }],
      structuredContent: {
        approvalId: pending.id,
        status: "denied",
        action,
      },
    };
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
