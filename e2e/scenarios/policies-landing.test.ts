// Cross-target (browser): a fresh workspace lands on `/policies` with an
// explainer empty state and a gated add form. The existing `policies-ui`
// scenario covers authoring rules from the tool tree; this scenario only
// pins the landing surface for a workspace that has never authored a rule.
//
// Asserts on:
//
//   1. The page renders the "Policies" heading and the rationale paragraph
//      under it (scoped to its `<p>`, not a bare text match).
//   2. The Active policies card-stack header is present, with the empty-
//      state explainer reading "No policies yet. Tools fall back to their
//      plugin's default approval behavior.", the product's guarantee that
//      absence-of-rule is a resolved default, not a loading state.
//   3. The add-policy form's pattern input exists and the submit button is
//      gated. Asserted as a value read of the `disabled` attribute, a
//      regression prints the actual element state instead of `false`.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Policies · a fresh workspace lands on an explainer empty state with a gated add form",
  { timeout: 90_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the policies page on a fresh workspace", async () => {
        await page.goto("/policies", { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Policies", exact: true }).waitFor();
      });

      await step("The rationale paragraph explains what policies do", async () => {
        await page
          .locator("p")
          .filter({
            hasText:
              "Override default approval behavior for tools. The most restrictive matched action wins.",
          })
          .waitFor();
      });

      await step("The Active policies card stack carries the empty-state explainer", async () => {
        await page
          .locator('[data-slot="card-stack-header"]')
          .filter({ hasText: "Active policies" })
          .waitFor();
        // Scope to the card stack's content area: a regression where the
        // explainer text leaks out of the empty state into a row body would
        // still satisfy a bare `getByText`.
        await page
          .locator('[data-slot="card-stack-content"]')
          .getByText(
            "No policies yet. Tools fall back to their plugin's default approval behavior.",
            { exact: true },
          )
          .waitFor();
      });

      await step("The add form is reachable and its submit is gated", async () => {
        const patternInput = page.getByPlaceholder("vercel.dns.* or *");
        await patternInput.waitFor();
        const addButton = page.getByRole("button", { name: "Add policy", exact: true });
        await addButton.waitFor();
        // Read the actual `disabled` attribute, a present attribute serializes
        // as the empty string; a regression that ungates the button drops the
        // attribute and this reads back as `null`.
        expect(
          await addButton.getAttribute("disabled"),
          "Add policy is disabled until a valid pattern is typed",
        ).toBe("");
      });
    });
  }),
);
