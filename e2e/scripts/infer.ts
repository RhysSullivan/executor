// Dev-time inference for agents working in this repo: ask a real model a
// question through the machine's OpenCode subscription, hermetically (no effect
// on your own OpenCode history). Prints the model's answer to stdout.
//
//   bun e2e/scripts/infer.ts "What is 6 * 7?"
//   bun e2e/scripts/infer.ts -m opencode/glm-5.1 "Summarize this error: ..."
//   bun e2e/scripts/infer.ts --json "..."     # full JSON event stream
//   cd e2e && bun run infer "..."             # via the package script
//
// Model ids are `opencode/<name>` — see e2e/evals/EVALS.md for the
// subscription model/quota table. Default is a cheap, high-quota model.
import { hasOpenCodeSubscription, runInference } from "../src/clients/inference";
import { hasOpenCode } from "../src/clients/opencode";

const DEFAULT_MODEL = "opencode/deepseek-v4-flash";

const parseArgs = (argv: readonly string[]) => {
  let model = DEFAULT_MODEL;
  let json = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-m" || arg === "--model") {
      model = argv[++i] ?? model;
    } else if (arg === "--json") {
      json = true;
    } else {
      rest.push(arg);
    }
  }
  return { model, json, prompt: rest.join(" ").trim() };
};

const main = async () => {
  if (!hasOpenCode()) {
    process.stderr.write("infer: the `opencode` binary is not installed.\n");
    process.exit(2);
  }
  if (!hasOpenCodeSubscription()) {
    process.stderr.write(
      "infer: no OpenCode credential found (~/.local/share/opencode/auth.json). Run `opencode auth login` first.\n",
    );
    process.exit(2);
  }

  const { model, json, prompt } = parseArgs(process.argv.slice(2));
  if (!prompt) {
    process.stderr.write(
      'infer: no prompt. Usage: bun e2e/scripts/infer.ts [-m model] "your prompt"\n',
    );
    process.exit(2);
  }

  const result = await runInference({ model, prompt });
  if (json) {
    process.stdout.write(
      result.rawStdout.endsWith("\n") ? result.rawStdout : `${result.rawStdout}\n`,
    );
  } else {
    process.stdout.write(`${result.answerText}\n`);
  }
  if (result.exitCode !== 0) {
    process.stderr.write(
      `infer: opencode exited ${result.exitCode} after ${result.durationMs}ms\n`,
    );
  }
};

// oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: top-level CLI error handler
main().catch((error) => {
  process.stderr.write(`infer: ${String(error)}\n`);
  process.exit(1);
});
