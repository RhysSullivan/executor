// Dev-time inference: drive the REAL OpenCode binary as a one-shot model call,
// hermetically. A throwaway OpenCode home borrows the machine's OpenCode
// subscription credential, so an agent (or a test) working in this repo can
// ask a real model a question — optionally with one of our MCP servers wired
// in — and get structured output back, without touching the developer's own
// OpenCode state/history.
//
// Two consumers:
//   - `e2e/scripts/infer.ts` — the CLI an agent runs while developing.
//   - `e2e/evals/` — the eval harness, which adds grading on top.
//
// What OpenCode does with the prompt, the tools, and (when wired) MCP OAuth is
// entirely its own code; we only provide the credential and read the result.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { makeOpenCodeHome, warmUp, type OpenCodeHome } from "./opencode";

// ---------------------------------------------------------------------------
// Subscription credential
// ---------------------------------------------------------------------------

/** The machine's OpenCode credential (e.g. the Go subscription), copied into
 *  each hermetic home so the throwaway OpenCode can run inference. */
const hostAuthFile = (): string => join(homedir(), ".local", "share", "opencode", "auth.json");

export const hasOpenCodeSubscription = (): boolean => existsSync(hostAuthFile());

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

export interface InferenceEvent {
  readonly type: string;
  readonly part?: {
    readonly type?: string;
    readonly text?: string;
    readonly tool?: string;
    readonly state?: {
      readonly status?: string;
      readonly input?: unknown;
      readonly output?: unknown;
    };
  };
}

export interface InferenceResult {
  /** Every JSON event opencode emitted, in order. */
  readonly events: readonly InferenceEvent[];
  /** All assistant text parts joined — "what the user read". */
  readonly answerText: string;
  /** Names of the tools the model invoked. */
  readonly toolNames: readonly string[];
  /** Raw stdout (JSONL), or stderr if stdout was empty — for artifacts. */
  readonly rawStdout: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export const answerTextOf = (events: readonly InferenceEvent[]): string =>
  events
    .filter((e) => e.type === "text" && typeof e.part?.text === "string")
    .map((e) => e.part?.text ?? "")
    .join("\n");

/** Tool-call inputs/outputs as one string, for content checks (e.g. "the
 *  credential never appears anywhere the model produced"). */
export const toolTrafficOf = (events: readonly InferenceEvent[]): string =>
  events
    .filter((e) => e.type === "tool_use")
    .map((e) => JSON.stringify(e.part?.state ?? {}))
    .join("\n");

export const toolNamesOf = (events: readonly InferenceEvent[]): readonly string[] =>
  events.filter((e) => e.type === "tool_use").map((e) => e.part?.tool ?? "");

const parseEvents = (stdout: string): InferenceEvent[] => {
  const events: InferenceEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-json-parse -- boundary: tolerant parse of opencode's JSONL event stream
    try {
      events.push(JSON.parse(line) as InferenceEvent);
    } catch {
      // Non-JSON line (banner, warning) — keep going.
    }
  }
  return events;
};

// ---------------------------------------------------------------------------
// Hermetic home
// ---------------------------------------------------------------------------

/** Optional MCP server to expose to the model. `consent` answers OpenCode's
 *  recorded browser hop: given the authorization URL it opened, deliver the
 *  code to OpenCode's local callback (the strategy is target-specific —
 *  Better Auth cookie, a login_hint redirect, etc.). */
export interface McpWiring {
  readonly serverName: string;
  readonly url: string;
  readonly consent: (authorizationUrl: string) => Promise<void>;
}

/** A throwaway OpenCode home with the subscription credential and all tool
 *  permissions pre-allowed (inference measures model behavior, not consent
 *  dialogs). Wires in one MCP server when `mcp` is provided. */
const makeInferenceHome = (mcp?: McpWiring): OpenCodeHome => {
  const home = makeOpenCodeHome(mcp?.serverName ?? "none", mcp?.url ?? "http://127.0.0.1:0/mcp");
  const authDir = join(home.env.XDG_DATA_HOME ?? "", "opencode");
  mkdirSync(authDir, { recursive: true });
  copyFileSync(hostAuthFile(), join(authDir, "auth.json"));
  writeFileSync(
    join(home.projectDir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      share: "disabled",
      permission: { "*": "allow" },
      ...(mcp ? { mcp: { [mcp.serverName]: { type: "remote", url: mcp.url } } } : {}),
    }),
  );
  return home;
};

/** Connect OpenCode to an MCP server before the run — `opencode run` does not
 *  initiate MCP OAuth itself, so without this the server's tools never exist
 *  and the model free-styles with its built-ins. Drives `opencode mcp auth`
 *  and answers the browser hop via `mcp.consent`. */
const connectMcp = async (home: OpenCodeHome, mcp: McpWiring): Promise<void> => {
  // First-run DB migration in a bare project — `mcp auth` misbehaves if it
  // doubles as first run (see warmUp's doc comment).
  warmUp(home);
  // ASYNC spawn (not spawnSync): the consent step polls on timers, and a
  // blocked event loop would starve it while `mcp auth` waits for the browser
  // hop it records via the open(1) shim.
  const sinceIndex = home.openedUrls().length;
  const auth = spawn("opencode", ["mcp", "auth", mcp.serverName], {
    cwd: home.projectDir,
    env: home.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const authExit = new Promise<void>((resolve) => {
    const killer = setTimeout(() => auth.kill("SIGKILL"), 90_000);
    auth.once("exit", () => {
      clearTimeout(killer);
      resolve();
    });
  });
  await waitForAuthorizationUrl(home, sinceIndex).then(mcp.consent);
  await authExit;
  const listed = spawnSync("opencode", ["mcp", "list"], {
    cwd: home.projectDir,
    env: home.env,
    timeout: 60_000,
    encoding: "utf8",
  });
  if (!`${listed.stdout}`.includes("connected")) {
    throw new Error(`inference: MCP server "${mcp.serverName}" never reached "connected"`);
  }
};

const waitForAuthorizationUrl = async (home: OpenCodeHome, sinceIndex: number): Promise<string> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const url = home.openedUrls()[sinceIndex];
    if (url) return url;
    await new Promise((tick) => setTimeout(tick, 250));
  }
  throw new Error("inference: opencode never opened an authorization URL");
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface InferenceOptions {
  /** Provider/model id, e.g. `opencode/deepseek-v4-flash`. */
  readonly model: string;
  readonly prompt: string;
  /** Kill the run after this many ms (default 240s). */
  readonly timeoutMs?: number;
  /** Expose one MCP server to the model, with a consent strategy. */
  readonly mcp?: McpWiring;
}

const DEFAULT_TIMEOUT_MS = 240_000;

export const runInference = async (options: InferenceOptions): Promise<InferenceResult> => {
  const home = makeInferenceHome(options.mcp);
  if (options.mcp) await connectMcp(home, options.mcp);
  const startedAt = Date.now();

  const child = spawn(
    "opencode",
    ["run", "-m", options.model, "--format", "json", options.prompt],
    {
      cwd: home.projectDir,
      // PWD must match cwd: an inherited PWD pointing at this repo invites the
      // model to wander the codebase instead of acting in an empty project.
      env: { ...home.env, PWD: home.projectDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

  // Keep answering browser hops for the whole run — the model may (re)connect
  // the MCP server mid-conversation, not just at pre-auth.
  let consented = home.openedUrls().length;
  const consentLoop = options.mcp
    ? setInterval(() => {
        const urls = home.openedUrls();
        if (urls.length > consented) {
          const index = consented;
          consented = urls.length;
          void options.mcp?.consent(urls[index]).catch(() => {});
        }
      }, 300)
    : undefined;

  const exitCode = await new Promise<number | null>((resolve) => {
    const killer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.once("exit", (code) => {
      clearTimeout(killer);
      resolve(code);
    });
  });
  if (consentLoop) clearInterval(consentLoop);

  const events = parseEvents(stdout);
  return {
    events,
    answerText: answerTextOf(events),
    toolNames: toolNamesOf(events),
    rawStdout: stdout.length > 0 ? stdout : stderr,
    exitCode,
    durationMs: Date.now() - startedAt,
  };
};
