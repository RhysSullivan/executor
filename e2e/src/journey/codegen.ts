// Generate a committed scenario from a recorded journey. The output is a normal
// scenario file (the same shape a human writes, see e2e/AGENTS.md): an Effect
// body that yields Target + Browser, mints a fresh identity, and drives one
// browser session of labelled steps. Terminal (`run`) and HTTP (`request`) steps
// run INSIDE that session, interleaved with the UI, so page state is never lost
// between them. It is meant to be read and edited after generation — promotion
// is the START of a scenario's life, not a frozen artifact.
import { codegenStep, isAssertion, isBrowserStep, stepLabel, type Step } from "./steps";

export interface JourneyFile {
  readonly target: string;
  readonly org: boolean;
  readonly steps: ReadonlyArray<Step>;
}

const INDENT = "      ";

const stepBlock = (step: Step): string => {
  const label = JSON.stringify(stepLabel(step));
  const body = codegenStep(step)
    .split("\n")
    .map((line) => `${INDENT}  ${line}`)
    .join("\n");
  return `${INDENT}await step(${label}, async () => {\n${body}\n${INDENT}});`;
};

/** A journey with no assertion proves nothing; one with no browser step isn't
 * what this tool generates (write a CLI/API test directly). `promote` checks
 * both. */
export const journeyHasAssertion = (journey: JourneyFile): boolean =>
  journey.steps.some(isAssertion);

export const journeyHasBrowserStep = (journey: JourneyFile): boolean =>
  journey.steps.some(isBrowserStep);

export const codegenScenario = (name: string, journey: JourneyFile): string => {
  const identityArg = journey.org ? "" : "{ org: false }";
  const body = journey.steps.map(stepBlock).join("\n");

  const needsExec = journey.steps.some((step) => step.kind === "run");
  const needsExpect = journey.steps.some(
    (step) => step.kind === "request" || (step.kind === "run" && step.contains !== undefined),
  );

  const imports: string[] = [];
  if (needsExec) {
    imports.push(`import { execFile } from "node:child_process";`);
    imports.push(`import { promisify } from "node:util";`);
    imports.push("");
  }
  if (needsExpect) imports.push(`import { expect } from "@effect/vitest";`);
  imports.push(`import { Effect } from "effect";`);
  imports.push("");
  imports.push(`import { scenario } from "../src/scenario";`);
  imports.push(`import { Browser, Target } from "../src/services";`);

  const execHelper = needsExec ? "\nconst execFileAsync = promisify(execFile);\n" : "";

  return `// Generated from an interactive browser journey: \`bun scripts/cli.ts promote ${journey.target} "<name>"\`.
// This is now an ordinary scenario — edit it freely. It drives the same Browser
// surface the exploration used, so a reviewer can judge the guarantee by
// reading it. Re-run with: E2E_${journey.target.toUpperCase()}_URL=<url> vitest run --project ${journey.target} <this file>
${imports.join("\n")}
${execHelper}
scenario(
  ${JSON.stringify(name)},
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity(${identityArg});
    yield* browser.session(identity, async ({ page, step }) => {
${body}
    });
  }),
);
`;
};
