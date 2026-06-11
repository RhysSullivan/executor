// The chat renderer half of the chat theater (see chat-theater.ts): a tiny
// agent-chat TUI that runs inside the recorded PTY and paints whatever the
// scenario's REAL MCP calls are doing. It performs no logic of its own — it
// reads base64-encoded JSON events on stdin and renders them with the
// pacing of a chat session (typed user input, streamed agent text, live
// tool spinners that run exactly as long as the real call did).
//
// Run with: bun agent-chat-tui.ts "<session title>"
import { createInterface } from "node:readline";

type TheaterEvent =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "tool-start"; readonly label: string }
  | { readonly type: "tool-end"; readonly ok: boolean; readonly note?: string }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "done" };

const out = (text: string) => process.stdout.write(text);

// The PTY would otherwise echo every incoming event line into the recording.
if (process.stdin.isTTY) process.stdin.setRawMode(true);

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const CLEAR_LINE = "\x1b[2K\r";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const sleep = (ms: number) => new Promise<void>((tick) => setTimeout(tick, ms));

const title = process.argv[2] ?? "executor session";
out(`${BOLD}${MAGENTA}●${RESET} ${BOLD}${title}${RESET}\n`);
out(`${DIM}${"─".repeat(Math.min(96, title.length + 24))}${RESET}\n`);

let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let spinnerLabel = "";

const startSpinner = (label: string) => {
  spinnerLabel = label;
  let frame = 0;
  out("\n");
  spinnerTimer = setInterval(() => {
    out(`${CLEAR_LINE}  ${CYAN}${SPINNER[frame % SPINNER.length]}${RESET} ${DIM}${label}${RESET}`);
    frame += 1;
  }, 80);
};

const stopSpinner = (ok: boolean, note?: string) => {
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = undefined;
  const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  out(`${CLEAR_LINE}  ${mark} ${DIM}${spinnerLabel}${note ? ` — ${note}` : ""}${RESET}\n`);
};

const handle = async (event: TheaterEvent): Promise<boolean> => {
  switch (event.type) {
    case "user": {
      out(`\n${BOLD}${CYAN}┃ you${RESET}  `);
      for (const ch of event.text) {
        out(ch);
        await sleep(18);
      }
      out("\n");
      return true;
    }
    case "assistant": {
      out(`\n${BOLD}${MAGENTA}● agent${RESET}  `);
      for (const piece of event.text.match(/.{1,3}/gs) ?? []) {
        out(piece);
        await sleep(12);
      }
      out("\n");
      return true;
    }
    case "tool-start": {
      startSpinner(event.label);
      return true;
    }
    case "tool-end": {
      stopSpinner(event.ok, event.note);
      return true;
    }
    case "status": {
      out(`\n  ${DIM}· ${event.text}${RESET}\n`);
      return true;
    }
    case "done": {
      out(`\n${DIM}${"─".repeat(40)}${RESET}\n${GREEN}✦ session complete${RESET}\n`);
      return false;
    }
  }
};

// Events arrive faster than they render; process strictly in order so the
// animations (not arrival time) set the pacing.
const queue: TheaterEvent[] = [];
let draining = false;
const drain = async () => {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const event = queue.shift();
    if (!event) break;
    const keepGoing = await handle(event);
    if (!keepGoing) {
      process.exit(0);
    }
  }
  draining = false;
};

createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: PTY stdin may echo stray keystrokes that aren't base64 JSON; ignore them
  try {
    queue.push(JSON.parse(Buffer.from(trimmed, "base64").toString("utf8")) as TheaterEvent);
  } catch {
    return;
  }
  void drain();
});
