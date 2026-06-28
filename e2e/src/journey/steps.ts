// The journey Step DSL: the single source of truth shared by interactive
// exploration and the generated scenario. ONE step description is both
// (a) executed live against the real product while the agent develops a flow
// (`executeStep`), and (b) emitted as the matching Playwright line inside a
// committed scenario (`codegenStep`). Because both sides read the same record,
// "turn what I just did into a test" is a translation, not a reimplementation:
// the generated test drives the exact surface the exploration drove.
//
// Steps are plain JSON (they persist to .dev/<target>.journey.json between CLI
// invocations), so they carry no closures — every action is a named primitive.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Page } from "playwright";

const execFileAsync = promisify(execFile);

/** ARIA roles the journey can target. A closed set keeps codegen honest and
 * the live `getByRole` calls type-safe (Playwright's role arg is a union). */
export type Role = "link" | "button" | "heading" | "textbox" | "tab" | "menuitem" | "checkbox";

export type Step =
  | { readonly kind: "goto"; readonly path: string; readonly label?: string }
  | {
      readonly kind: "clickRole";
      readonly role: Role;
      readonly name: string;
      readonly label?: string;
    }
  | { readonly kind: "clickText"; readonly text: string; readonly label?: string }
  | {
      readonly kind: "fill";
      readonly field: string;
      readonly value: string;
      readonly label?: string;
    }
  | { readonly kind: "press"; readonly key: string; readonly label?: string }
  | { readonly kind: "expectText"; readonly text: string; readonly label?: string }
  | { readonly kind: "expectUrl"; readonly contains: string; readonly label?: string }
  // A terminal command. `{base}` expands to the target's base URL, so a journey
  // can hit the same instance the UI is driving (curl, npx add-mcp, executor …).
  // `contains` (when set) asserts on the combined stdout+stderr.
  | {
      readonly kind: "run";
      readonly command: string;
      readonly contains?: string;
      readonly label?: string;
    }
  // An HTTP call through the page's own authenticated session (relative paths
  // resolve against the base URL). `contains` asserts on the response body;
  // without it, the assertion is a 2xx.
  | {
      readonly kind: "request";
      readonly method: string;
      readonly path: string;
      readonly contains?: string;
      readonly label?: string;
    };

/** Assertions are the steps a reviewer reads as the guarantee — a journey with
 * none asserts nothing, so `promote` refuses it. A `run`/`request` is an
 * assertion when it carries an expectation (`contains`, or `request`'s 2xx). */
export const isAssertion = (step: Step): boolean =>
  step.kind === "expectText" ||
  step.kind === "expectUrl" ||
  step.kind === "request" ||
  (step.kind === "run" && step.contains !== undefined);

export const isBrowserStep = (step: Step): boolean =>
  step.kind !== "run" && step.kind !== "request";

/** The human-readable step name (the `step(label, …)` group + screenshot
 * caption). The agent can override per step; this is the sensible default so a
 * generated test reads as a journey even when labels were left implicit. */
export const stepLabel = (step: Step): string => {
  if (step.label) return step.label;
  switch (step.kind) {
    case "goto":
      return `Open ${step.path}`;
    case "clickRole":
      return `Click the ${JSON.stringify(step.name)} ${step.role}`;
    case "clickText":
      return `Click ${JSON.stringify(step.text)}`;
    case "fill":
      return `Fill ${JSON.stringify(step.field)}`;
    case "press":
      return `Press ${step.key}`;
    case "expectText":
      return `See ${JSON.stringify(step.text)}`;
    case "expectUrl":
      return `Land on a URL containing ${JSON.stringify(step.contains)}`;
    case "run":
      return step.contains
        ? `Run ${JSON.stringify(step.command)} and see ${JSON.stringify(step.contains)}`
        : `Run ${JSON.stringify(step.command)}`;
    case "request":
      return step.contains
        ? `${step.method} ${step.path} returns ${JSON.stringify(step.contains)}`
        : `${step.method} ${step.path} succeeds`;
  }
};

const ASSERT_TIMEOUT = 15_000;

export interface StepContext {
  readonly page: Page;
  /** The target's base URL — `{base}` in a `run` command expands to this. */
  readonly baseUrl: string;
}

/** Expand `{base}` so a terminal command can reach the instance under test. */
const withBase = (command: string, baseUrl: string): string =>
  command.replaceAll("{base}", baseUrl);

/** Drive one step against a live page. Assertions throw on failure (a missing
 * text, a wrong URL, a non-matching command output) so it surfaces immediately
 * while exploring, the same way it would fail the generated test. Returns any
 * textual output (terminal / HTTP) so the caller can show it. */
export const executeStep = async (ctx: StepContext, step: Step): Promise<string | undefined> => {
  const { page } = ctx;
  switch (step.kind) {
    case "goto":
      await page.goto(step.path, { waitUntil: "networkidle" });
      return;
    case "clickRole":
      await page.getByRole(step.role, { name: step.name }).first().click();
      return;
    case "clickText":
      await page.getByText(step.text).first().click();
      return;
    case "fill":
      await page.getByLabel(step.field).first().fill(step.value);
      return;
    case "press":
      await page.keyboard.press(step.key);
      return;
    case "expectText":
      await page
        .getByText(step.text)
        .first()
        .waitFor({ state: "visible", timeout: ASSERT_TIMEOUT });
      return;
    case "expectUrl":
      await page.waitForURL((url) => url.toString().includes(step.contains), {
        timeout: ASSERT_TIMEOUT,
      });
      return;
    case "run": {
      const result = await execFileAsync("sh", ["-c", withBase(step.command, ctx.baseUrl)]).catch(
        (error: { stdout?: string; stderr?: string }) => ({
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? String(error),
        }),
      );
      const output = `${result.stdout}${result.stderr}`;
      if (step.contains !== undefined && !output.includes(step.contains)) {
        throw new Error(
          `\`run\` output did not contain ${JSON.stringify(step.contains)}\n${output.slice(0, 1000)}`,
        );
      }
      return output.trim().slice(0, 2000);
    }
    case "request": {
      const response = await page.request.fetch(step.path, { method: step.method });
      const body = await response.text();
      if (step.contains !== undefined) {
        if (!body.includes(step.contains)) {
          throw new Error(
            `${step.method} ${step.path} body did not contain ${JSON.stringify(step.contains)} (status ${response.status()})`,
          );
        }
      } else if (!response.ok()) {
        throw new Error(`${step.method} ${step.path} returned ${response.status()}`);
      }
      return `${response.status()} ${body.slice(0, 800)}`;
    }
  }
};

/** The Playwright line(s) for this step, as they appear inside the generated
 * scenario's `step(label, async () => { … })` body. Mirrors `executeStep`
 * exactly — same locator, same call — so live behavior and the test match. */
export const codegenStep = (step: Step): string => {
  const s = (value: string): string => JSON.stringify(value);
  switch (step.kind) {
    case "goto":
      return `await page.goto(${s(step.path)}, { waitUntil: "networkidle" });`;
    case "clickRole":
      return `await page.getByRole(${s(step.role)}, { name: ${s(step.name)} }).first().click();`;
    case "clickText":
      return `await page.getByText(${s(step.text)}).first().click();`;
    case "fill":
      return `await page.getByLabel(${s(step.field)}).first().fill(${s(step.value)});`;
    case "press":
      return `await page.keyboard.press(${s(step.key)});`;
    case "expectText":
      // The repo's browser-assertion idiom: waiting for the element IS the
      // assertion (a timeout fails the step with the locator in the message).
      return `await page.getByText(${s(step.text)}).first().waitFor();`;
    case "expectUrl":
      return `await page.waitForURL((url) => url.toString().includes(${s(step.contains)}));`;
    case "run": {
      const lines = [
        `const { stdout } = await execFileAsync("sh", ["-c", ${backtick(step.command)}]);`,
      ];
      if (step.contains !== undefined) {
        lines.push(
          `expect(stdout, "the command output is as expected").toContain(${s(step.contains)});`,
        );
      }
      return lines.join("\n");
    }
    case "request": {
      const lines = [
        `const response = await page.request.fetch(${s(step.path)}, { method: ${s(step.method)} });`,
      ];
      lines.push(
        step.contains !== undefined
          ? `expect(await response.text(), "the response is as expected").toContain(${s(step.contains)});`
          : `expect(response.ok(), "the request succeeded").toBe(true);`,
      );
      return lines.join("\n");
    }
  }
};

/** A terminal command as a template literal so `{base}` becomes `target.baseUrl`
 * (which is in scope in the generated body). Backticks in the command are
 * escaped so the literal stays valid. */
const backtick = (command: string): string =>
  "`" +
  command
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("{base}", "${target.baseUrl}") +
  "`";
