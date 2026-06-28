// Replay a journey live, from a clean browser, and report what the page looks
// like afterward. This is the development loop: each `browse` command appends a
// step and replays the WHOLE journey from scratch, so the flow the agent is
// building is, at every moment, exactly what the generated test will run — a
// step that doesn't reproduce fails here, not later. The returned observation
// (url, title, the page's interactive controls) is how the agent, which can't
// see the screen, decides the next step; the screenshot is for a human.
import { chromium, type Page } from "playwright";

import type { Identity, Target } from "../target";
import { executeStep, type Step } from "./steps";

export interface Control {
  readonly role: string;
  readonly name: string;
}

export interface Observation {
  readonly url: string;
  readonly title: string;
  /** The interactive elements on the page, as (role, accessible name) — the
   * vocabulary the next clickRole/fill step is written against. */
  readonly controls: ReadonlyArray<Control>;
  readonly screenshotPath: string;
  /** Textual output of the last terminal/HTTP step, if any — so the agent sees
   * what a `run`/`request` produced, not just the page. */
  readonly lastOutput?: string;
  /** Index of the step that threw, with its message — undefined on success. */
  readonly failedStep?: { readonly index: number; readonly error: string };
}

const OBSERVED_ROLES = ["link", "button", "textbox", "tab", "menuitem", "checkbox"] as const;
const PER_ROLE_CAP = 30;

/** A compact, deduped list of the page's interactive controls. Names come from
 * the accessible name (text / aria-label / placeholder), trimmed. */
const snapshotControls = async (page: Page): Promise<Control[]> => {
  const seen = new Set<string>();
  const controls: Control[] = [];
  for (const role of OBSERVED_ROLES) {
    const elements = await page.getByRole(role).all();
    for (const element of elements.slice(0, PER_ROLE_CAP)) {
      const raw =
        (await element.textContent().catch(() => null))?.trim() ||
        (await element.getAttribute("aria-label").catch(() => null)) ||
        (await element.getAttribute("placeholder").catch(() => null)) ||
        "";
      const name = raw.replace(/\s+/g, " ").trim().slice(0, 70);
      if (!name) continue;
      const key = `${role}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      controls.push({ role, name });
    }
  }
  return controls;
};

export const replayJourney = async (
  target: Target,
  identity: Identity,
  steps: ReadonlyArray<Step>,
  options: { readonly screenshotPath: string },
): Promise<Observation> => {
  const browser = await chromium.launch();
  let failedStep: Observation["failedStep"];
  try {
    const context = await browser.newContext({
      colorScheme: "dark",
      viewport: { width: 1280, height: 800 },
      baseURL: target.baseUrl,
    });
    // Same identity injection the Browser surface does, so the live page is the
    // logged-in page the generated test will drive.
    if (identity.cookies?.length) {
      await context.addCookies(
        identity.cookies.map((cookie) => ({ ...cookie, url: target.baseUrl })),
      );
    }
    const page = await context.newPage();
    let lastOutput: string | undefined;
    for (let index = 0; index < steps.length; index++) {
      try {
        const output = await executeStep({ page, baseUrl: target.baseUrl }, steps[index]!);
        if (output !== undefined) lastOutput = output;
      } catch (error) {
        failedStep = { index, error: error instanceof Error ? error.message : String(error) };
        break;
      }
    }
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.screenshot({ path: options.screenshotPath }).catch(() => {});
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      controls: await snapshotControls(page).catch(() => []),
      screenshotPath: options.screenshotPath,
      lastOutput,
      failedStep,
    };
  } finally {
    await browser.close();
  }
};
