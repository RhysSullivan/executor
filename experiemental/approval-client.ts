import path from "node:path";

type ApprovalStatus = "pending" | "approved" | "denied";

interface ApprovalItem {
  id: string;
  title: string;
  details: string;
  status: ApprovalStatus;
  createdAt: number;
}

function parseArgs(argv: string[]): { session: string; inline: boolean; tmuxSession: string; agentCommand: string } {
  const session = argv[0] && !argv[0].startsWith("-") ? argv[0] : "claude";
  const inline = argv.includes("--inline");

  const tmuxSessionFlagIndex = argv.indexOf("--tmux-session");
  const tmuxSession = tmuxSessionFlagIndex >= 0 && argv[tmuxSessionFlagIndex + 1]
    ? String(argv[tmuxSessionFlagIndex + 1])
    : "executor-approvals";

  const agentCommandFlagIndex = argv.indexOf("--agent-cmd");
  const agentCommand = agentCommandFlagIndex >= 0 && argv[agentCommandFlagIndex + 1]
    ? String(argv[agentCommandFlagIndex + 1])
    : session;

  return { session, inline, tmuxSession, agentCommand };
}

function hasTmuxBinary(): boolean {
  const result = Bun.spawnSync({ cmd: ["tmux", "-V"] });
  return result.exitCode === 0;
}

function getTmuxClients(): string[] {
  const result = Bun.spawnSync({ cmd: ["tmux", "list-clients", "-F", "#{client_name}"] });
  if (result.exitCode !== 0) return [];

  return Buffer.from(result.stdout)
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "no current client");
}

async function launchTmuxPopup(session: string, clientTarget: string): Promise<void> {
  const scriptPath = path.resolve(import.meta.dir, "approval-client.ts");
  const command = `bun run ${scriptPath} ${session} --inline`;
  Bun.spawnSync({
    cmd: ["tmux", "display-popup", "-t", clientTarget, "-E", "-w", "82%", "-h", "70%", command],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function tmuxSessionExists(tmuxSession: string): boolean {
  const result = Bun.spawnSync({ cmd: ["tmux", "has-session", "-t", tmuxSession] });
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

function ensureSessionUiOptions(tmuxSession: string): void {
  runTmuxCommand(["tmux", "set-option", "-t", tmuxSession, "mouse", "on"]);
  runTmuxCommand(["tmux", "set-option", "-t", tmuxSession, "pane-border-status", "top"]);
  runTmuxCommand(["tmux", "set-option", "-t", tmuxSession, "pane-border-format", "#{pane_index}: #{pane_title}"]);
}

function setPaneTitles(windowTarget: string): void {
  runTmuxCommand(["tmux", "select-pane", "-t", `${windowTarget}.0`, "-T", "Claude"]);
  runTmuxCommand(["tmux", "select-pane", "-t", `${windowTarget}.1`, "-T", "Approvals"]);
}

async function launchManagedTmuxWorkspace(session: string, tmuxSession: string, agentCommand: string): Promise<boolean> {
  const scriptPath = path.resolve(import.meta.dir, "approval-client.ts");
  const approvalCommand = `bun run ${shellQuote(scriptPath)} ${shellQuote(session)} --inline`;

  if (!tmuxSessionExists(tmuxSession)) {
    const created = runTmuxCommand(["tmux", "new-session", "-d", "-s", tmuxSession, agentCommand]);
    if (!created) return false;

    ensureSessionUiOptions(tmuxSession);

    const split = runTmuxCommand(["tmux", "split-window", "-t", `${tmuxSession}:0`, "-v", "-p", "30", approvalCommand]);
    if (!split) return false;

    setPaneTitles(`${tmuxSession}:0`);
    runTmuxCommand(["tmux", "select-pane", "-t", `${tmuxSession}:0.0`]);
    return runTmuxCommand(["tmux", "attach-session", "-t", tmuxSession]);
  }

  const windowName = `exec-${Date.now()}`;
  const windowTarget = `${tmuxSession}:${windowName}`;
  ensureSessionUiOptions(tmuxSession);

  const createdWindow = runTmuxCommand(["tmux", "new-window", "-t", `${tmuxSession}:`, "-n", windowName, agentCommand]);
  if (!createdWindow) return false;

  const splitWindow = runTmuxCommand(["tmux", "split-window", "-t", windowTarget, "-v", "-p", "30", approvalCommand]);
  if (!splitWindow) return false;

  setPaneTitles(windowTarget);
  runTmuxCommand(["tmux", "select-pane", "-t", `${windowTarget}.0`]);
  return runTmuxCommand(["tmux", "attach-session", "-t", tmuxSession]);
}

function makeApproval(session: string, index: number): ApprovalItem {
  const actions = [
    "Write DNS record",
    "Delete production file",
    "Rotate API token",
    "Deploy migration",
    "Run destructive cleanup",
  ];

  const title = actions[index % actions.length] ?? "Tool action";
  const id = `appr_${crypto.randomUUID().slice(0, 8)}`;

  return {
    id,
    title,
    details: `Session: ${session} -> tools.example.action()`,
    status: "pending",
    createdAt: Date.now(),
  };
}

function statusMarker(status: ApprovalStatus): string {
  if (status === "approved") return "[approved]";
  if (status === "denied") return "[denied]";
  return "[pending]";
}

function clearAndRender(session: string, approvals: ApprovalItem[], selected: number): void {
  process.stdout.write("\x1Bc");
  process.stdout.write("Approval Popup Demo\n");
  process.stdout.write(`Session: ${session}\n`);
  process.stdout.write("Controls: j/k move  a approve  d deny  n new request  q quit\n");
  process.stdout.write("tmux tip: Ctrl+b then o to switch panes (mouse is enabled).\n");
  process.stdout.write("-".repeat(72) + "\n");

  if (approvals.length === 0) {
    process.stdout.write("No approvals. Press n to enqueue one.\n");
    return;
  }

  approvals.forEach((item, idx) => {
    const pointer = idx === selected ? ">" : " ";
    const time = new Date(item.createdAt).toLocaleTimeString();
    process.stdout.write(`${pointer} ${statusMarker(item.status)} ${item.id}  ${item.title}  (${time})\n`);
    process.stdout.write(`    ${item.details}\n`);
  });
}

async function runInlineUi(session: string): Promise<number> {
  const approvals: ApprovalItem[] = [makeApproval(session, 0)];
  let selected = 0;
  let sequence = 1;

  const enqueueTimer = setInterval(() => {
    approvals.unshift(makeApproval(session, sequence));
    sequence += 1;
    selected = 0;
    clearAndRender(session, approvals, selected);
  }, 12000);

  const cleanup = (): void => {
    clearInterval(enqueueTimer);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  clearAndRender(session, approvals, selected);

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

    process.stdin.on("data", (chunk) => {
      const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");

      if (key === "\u0003" || key === "q") {
        finish(0);
        return;
      }

      if (key === "j" || key === "\u001B[B") {
        if (approvals.length > 0) {
          selected = Math.min(approvals.length - 1, selected + 1);
        }
        clearAndRender(session, approvals, selected);
        return;
      }

      if (key === "k" || key === "\u001B[A") {
        if (approvals.length > 0) {
          selected = Math.max(0, selected - 1);
        }
        clearAndRender(session, approvals, selected);
        return;
      }

      if (key === "n") {
        approvals.unshift(makeApproval(session, sequence));
        sequence += 1;
        selected = 0;
        clearAndRender(session, approvals, selected);
        return;
      }

      const current = approvals[selected];
      if (!current || current.status !== "pending") {
        return;
      }

      if (key === "a") {
        current.status = "approved";
        clearAndRender(session, approvals, selected);
        return;
      }

      if (key === "d") {
        current.status = "denied";
        clearAndRender(session, approvals, selected);
      }
    });
  });
}

async function main(): Promise<number> {
  const { session, inline, tmuxSession, agentCommand } = parseArgs(process.argv.slice(2));

  if (!inline) {
    if (!hasTmuxBinary()) {
      console.error("tmux is not installed.");
      console.error("Install tmux, or rerun with --inline.");
      return 1;
    }

    const clients = getTmuxClients();
    const target = clients[0];
    if (target) {
      await launchTmuxPopup(session, target);
      return 0;
    }

    console.log(`No active tmux clients. Launching '${agentCommand}' with approvals in session '${tmuxSession}'...`);
    const started = await launchManagedTmuxWorkspace(session, tmuxSession, agentCommand);
    if (started) {
      return 0;
    }

    console.error("Unable to launch managed tmux workspace.");
    console.error("You can still run the inline demo with --inline.");
    return 1;
  }

  return await runInlineUi(session);
}

const code = await main();
process.exit(code);
