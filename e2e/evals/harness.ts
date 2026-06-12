// The eval harness: run a real OpenCode inference trial against a real target,
// then grade the result with deterministic checks. One eval = one task × one
// model × one trial; the vitest file fans out the matrix and aggregates pass
// rates. The inference mechanics live in the reusable `runInference` primitive
// (src/clients/inference.ts); this file adds only the target-specific MCP
// consent strategy and the grading vocabulary.
//
// Design intent (EVALS.md): the agent gets the user's one-line ask and
// whatever our MCP server advertises — no extra system prompt, no coached
// tool order. The tool descriptions are what's under test.
import { Effect } from "effect";

import type { Identity, Target } from "../src/target";
import {
  hasOpenCodeSubscription,
  runInference,
  toolTrafficOf,
  type InferenceResult,
} from "../src/clients/inference";

// ---------------------------------------------------------------------------
// Config — every knob is an env var so CI and local runs share one path.
// ---------------------------------------------------------------------------

export const EVAL_DEFAULT_MODELS = [
  // Spread across separate subscription quota pools; see EVALS.md for the table.
  "opencode/deepseek-v4-flash",
  "opencode/minimax-m2.5",
  "opencode/kimi-k2.5",
] as const;

export const evalsEnabled = (): boolean => process.env.EVAL === "1";

export const evalModels = (): readonly string[] =>
  process.env.EVAL_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean) ?? EVAL_DEFAULT_MODELS;

export const evalTrials = (): number => {
  const parsed = Number(process.env.EVAL_TRIALS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
};

export const hasGoSubscription = hasOpenCodeSubscription;

// Re-exported for grading code (tasks.ts) that inspects tool traffic.
export const trialToolTraffic = toolTrafficOf;

export type TrialResult = InferenceResult;

export interface RunTrialOptions {
  readonly serverName: string;
  readonly mcpUrl: string;
  readonly model: string;
  readonly prompt: string;
  /** Identity whose session cookie answers the MCP OAuth consent hop. */
  readonly identity: Identity;
  readonly timeoutMs: number;
}

/** Answer OpenCode's recorded browser hop the way a signed-in selfhost user
 *  would: drive the authorize URL with the identity's Better Auth session
 *  cookie and deliver the code to OpenCode's localhost callback. (Cloud's
 *  emulator dialect uses login_hint instead — this is the selfhost path.) */
const cookieConsent =
  (identity: Identity) =>
  async (authorizationUrl: string): Promise<void> => {
    const cookie = identity.headers?.cookie ?? "";
    const authorize = await fetch(authorizationUrl, { headers: { cookie }, redirect: "manual" });
    const location = authorize.headers.get("location");
    if (!location) {
      throw new Error(`eval consent: authorize did not redirect (${authorize.status})`);
    }
    const callback = await fetch(location);
    if (!callback.ok) throw new Error(`eval consent: callback failed (${callback.status})`);
  };

export const runTrial = (options: RunTrialOptions): Effect.Effect<TrialResult, Error> =>
  Effect.promise(() =>
    runInference({
      model: options.model,
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
      mcp: {
        serverName: options.serverName,
        url: options.mcpUrl,
        consent: cookieConsent(options.identity),
      },
    }),
  );

// ---------------------------------------------------------------------------
// Task registry — a task is a prompt plus deterministic graders.
// ---------------------------------------------------------------------------

export interface GradeContext {
  readonly trial: TrialResult;
  readonly target: Target;
  readonly identity: Identity;
  /** Authenticated fetch against the target's API, for outcome checks. */
  readonly apiGet: (path: string) => Promise<unknown>;
}

export interface GradeCheck {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string;
}

export interface EvalTask {
  readonly id: string;
  /** The user's one-line ask — the ONLY prompt the model gets. */
  readonly prompt: (input: { readonly integration: string }) => string;
  readonly timeoutMs: number;
  /** Deterministic checks; the trial passes iff every check passes. */
  readonly grade: (
    ctx: GradeContext,
    input: { readonly integration: string },
  ) => Promise<readonly GradeCheck[]>;
}
