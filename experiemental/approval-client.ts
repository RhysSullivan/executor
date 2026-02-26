import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

type ApprovalStatus = "pending" | "approved" | "denied";

interface ApprovalItem {
  id: string;
  action: string;
  justification: string;
  createdAt: number;
  status: ApprovalStatus;
  decidedAt: number | null;
}

interface PersistedState {
  approvals: ApprovalItem[];
}

interface ParsedArgs {
  session: string;
  inline: boolean;
  tmuxSession: string;
  agentCommand: string;
  approvalId: string | null;
}

const DEFAULT_MCP_CONFIG_PATH = path.resolve(import.meta.dir, "claude-mcp-demo.json");
const DEFAULT_PM_MCP_CONFIG_PATH = path.resolve(import.meta.dir, "claude-mcp-pm.json");
const HOME_DIR = process.env.HOME ?? ".";
const STATE_PATH = path.join(HOME_DIR, ".executor-lite-approvals", "mcp-state.json");

mkdirSync(path.dirname(STATE_PATH), { recursive: true });

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function getFlag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return typeof value === "string" ? value : null;
}

function defaultAgentCommand(session: string): string {
  if (session === "claude") {
    const allowedTools = "mcp__memory-approval-demo__dangerous_action";
    return `claude --strict-mcp-config --mcp-config ${shellQuote(DEFAULT_MCP_CONFIG_PATH)} --allowedTools ${shellQuote(allowedTools)} --permission-mode bypassPermissions`;
  }

  if (session === "claude-pm") {
    const allowedTools = "mcp__executor-v2-local__executor.execute";
    return `claude --strict-mcp-config --mcp-config ${shellQuote(DEFAULT_PM_MCP_CONFIG_PATH)} --allowedTools ${shellQuote(allowedTools)} --permission-mode bypassPermissions`;
  }

  return session;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionalSession = argv[0] && !argv[0].startsWith("-") ? argv[0] : "claude";
  const session = getFlag(argv, "--session") ?? positionalSession;
  const inline = argv.includes("--inline");

  const tmuxSession = getFlag(argv, "--tmux-session") ?? "executor-approvals";
  const agentCommand = getFlag(argv, "--agent-cmd") ?? defaultAgentCommand(session);
  const approvalId = getFlag(argv, "--approval-id");

  return { session, inline, tmuxSession, agentCommand, approvalId };
}

function hasTmuxBinary(): boolean {
  const result = Bun.spawnSync({ cmd: ["tmux", "-V"] });
  return result.exitCode === 0;
}

function runTmuxCommand(cmd: string[]): boolean {
  const result = Bun.spawnSync({
    cmd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode === 0;
}

function tmuxSessionExists(tmuxSession: string): boolean {
  const result = Bun.spawnSync({ cmd: ["tmux", "has-session", "-t", tmuxSession] });
  return result.exitCode === 0;
}

function ensureSessionUiOptions(tmuxSession: string): void {
  runTmuxCommand(["tmux", "set-option", "-t", tmuxSession, "mouse", "on"]);
  runTmuxCommand(["tmux", "set-option", "-t", tmuxSession, "pane-border-status", "top"]);
  runTmuxCommand(["tmux", "set-option", "-t", tmuxSession, "pane-border-format", "#{pane_index}: #{pane_title}"]);
}

async function launchManagedTmuxWorkspace(tmuxSession: string, agentCommand: string): Promise<boolean> {
  if (!tmuxSessionExists(tmuxSession)) {
    const created = runTmuxCommand(["tmux", "new-session", "-d", "-s", tmuxSession, agentCommand]);
    if (!created) return false;

    ensureSessionUiOptions(tmuxSession);
    runTmuxCommand(["tmux", "select-pane", "-t", `${tmuxSession}:0.0`, "-T", "Claude"]);
    return runTmuxCommand(["tmux", "attach-session", "-t", tmuxSession]);
  }

  const windowName = `exec-${Date.now()}`;
  const windowTarget = `${tmuxSession}:${windowName}`;
  ensureSessionUiOptions(tmuxSession);

  const createdWindow = runTmuxCommand(["tmux", "new-window", "-t", `${tmuxSession}:`, "-n", windowName, agentCommand]);
  if (!createdWindow) return false;

  runTmuxCommand(["tmux", "select-pane", "-t", `${windowTarget}.0`, "-T", "Claude"]);
  runTmuxCommand(["tmux", "select-window", "-t", windowTarget]);
  return runTmuxCommand(["tmux", "attach-session", "-t", tmuxSession]);
}

function loadState(): PersistedState {
  if (!existsSync(STATE_PATH)) return { approvals: [] };

  try {
    const text = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(text) as Partial<PersistedState>;
    if (!parsed || !Array.isArray(parsed.approvals)) {
      return { approvals: [] };
    }

    return {
      approvals: parsed.approvals.filter((entry): entry is ApprovalItem => {
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

function saveState(state: PersistedState): void {
  const tempPath = `${STATE_PATH}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2));
  renameSync(tempPath, STATE_PATH);
}

function findApproval(state: PersistedState, approvalId: string | null): ApprovalItem | null {
  if (approvalId) {
    return state.approvals.find((item) => item.id === approvalId) ?? null;
  }

  return state.approvals.find((item) => item.status === "pending") ?? null;
}

function decideApproval(approvalId: string, status: ApprovalStatus): ApprovalItem | null {
  const state = loadState();
  const target = state.approvals.find((item) => item.id === approvalId);
  if (!target || target.status !== "pending") return null;

  target.status = status;
  target.decidedAt = Date.now();
  saveState(state);
  return target;
}

function renderInline(session: string, current: ApprovalItem | null): void {
  process.stdout.write("\x1Bc");
  process.stdout.write("Approval Pane (MCP-driven)\n");
  process.stdout.write(`Session: ${session}\n`);
  process.stdout.write("Controls: a approve  d deny  q quit\n");
  process.stdout.write("This pane only appears when an MCP approval is pending.\n");
  process.stdout.write("-".repeat(84) + "\n");

  if (!current) {
    process.stdout.write("No pending approval. Closing...\n");
    return;
  }

  const created = new Date(current.createdAt).toLocaleTimeString();
  process.stdout.write(`[pending] ${current.id}\n`);
  process.stdout.write(`action: ${current.action}\n`);
  process.stdout.write(`created: ${created}\n`);
  if (current.justification.trim().length > 0) {
    process.stdout.write(`justification: ${current.justification}\n`);
  }
}

async function runInlineUi(session: string, approvalId: string | null): Promise<number> {
  let current = findApproval(loadState(), approvalId);
  renderInline(session, current);

  const cleanup = (): void => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  return await new Promise<number>((resolve) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdin.setEncoding("utf8");
    process.stdin.resume();

    const finish = (code: number) => {
      cleanup();
      resolve(code);
    };

    const poll = setInterval(() => {
      current = findApproval(loadState(), approvalId);
      if (!current) {
        clearInterval(poll);
        renderInline(session, null);
        setTimeout(() => finish(0), 250);
        return;
      }
      renderInline(session, current);
    }, 500);

    process.stdin.on("data", (chunk) => {
      const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");

      if (key === "\u0003" || key === "q") {
        clearInterval(poll);
        finish(0);
        return;
      }

      if (!current) return;

      if (key === "a") {
        decideApproval(current.id, "approved");
        clearInterval(poll);
        finish(0);
        return;
      }

      if (key === "d") {
        decideApproval(current.id, "denied");
        clearInterval(poll);
        finish(0);
      }
    });
  });
}

async function main(): Promise<number> {
  const { session, inline, tmuxSession, agentCommand, approvalId } = parseArgs(process.argv.slice(2));

  if (!inline) {
    if (!hasTmuxBinary()) {
      console.error("tmux is not installed.");
      console.error("Install tmux, or rerun with --inline.");
      return 1;
    }

    console.log(`Launching '${agentCommand}' in tmux session '${tmuxSession}'...`);
    const started = await launchManagedTmuxWorkspace(tmuxSession, agentCommand);
    if (started) return 0;

    console.error("Unable to launch managed tmux workspace.");
    console.error("You can still run the inline pane with --inline.");
    return 1;
  }

  return await runInlineUi(session, approvalId);
}

const code = await main();
process.exit(code);
