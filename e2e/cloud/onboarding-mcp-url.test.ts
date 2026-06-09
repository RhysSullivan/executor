// Cloud-specific (browser): the onboarding MCP-setup step gives the user an
// org-scoped MCP server URL and a matching install command. Driven through the
// real web UI as a fresh user who has no organization yet — follows the same
// two-step onboarding path real users take (create org → Connect your MCP
// client), then verifies that both the displayed URL and the install command
// are pinned to the newly-created organization.
import { Effect } from "effect";

import { scenario } from "../src/scenario";

scenario(
  "Onboarding · the MCP setup step hands the user their org-scoped MCP server URL",
  { needs: ["browser"] },
  (ctx) =>
    Effect.gen(function* () {
      ctx.rec.say(
        "A brand-new user with no organization goes through the two-step onboarding flow: first creates an org, then lands on 'Connect your MCP client' — where both the displayed URL and the install command must be scoped to that org.",
      );
      const identity = yield* ctx.target.newIdentity({ org: false });

      yield* ctx.browser.session(identity, async ({ page, step }) => {
        await step(
          "A fresh user without an org lands on the create-org onboarding page",
          async () => {
            await page.goto("/", { waitUntil: "networkidle" });
            // Step 1 of 2 — the org-name input is the landmark that proves we're on onboarding.
            await page.getByPlaceholder("Northwind Labs").waitFor();
          },
        );

        await step("Create an organization to advance to the MCP setup step", async () => {
          await page.getByPlaceholder("Northwind Labs").fill("Test Org");
          await page.getByRole("button", { name: "Create organization" }).click();
          // Successful creation navigates to the 'Connect your MCP client' step.
          await page.getByText("Connect your MCP client").waitFor();
        });

        await step("Read the MCP server URL displayed on the setup page", async () => {
          // The URL is rendered inside the 'MCP server URL' section as monospace text.
          const urlSection = page.getByRole("region", { name: "MCP server URL" });
          await urlSection.waitFor();
          // Wait until the endpoint is populated (the component defers origin to useEffect).
          await page.waitForFunction(() => {
            const section = document.querySelector('[aria-label="MCP server URL"]');
            const span = section?.querySelector("span.font-mono");
            return span && span.textContent !== "…" && span.textContent !== "";
          });
        });

        const mcpUrlSection = page.getByRole("region", { name: "MCP server URL" });
        const mcpUrl = await mcpUrlSection.locator("span.font-mono").innerText();
        ctx.rec.step("browser", `MCP server URL displayed: ${mcpUrl}`);

        ctx.rec
          .expect(mcpUrl, "MCP URL is org-scoped (contains /org_<id>/mcp)")
          .toMatch(/\/org_[^/]+\/mcp/);

        await step(
          "Read the install command and verify it embeds the same org-scoped URL",
          async () => {
            // The install command lives inside a <code> element within the 'Install command' section.
            const installSection = page.getByRole("region", { name: "Install command" });
            await installSection.waitFor();
          },
        );

        const installSection = page.getByRole("region", { name: "Install command" });
        const installCommand = await installSection.locator("code").innerText();
        ctx.rec.step("browser", `Install command: ${installCommand}`);

        // Extract the org segment from the displayed URL to confirm the install
        // command references the same org — not a different one or a bare /mcp path.
        const orgId = /\/(org_[^/]+)\/mcp/.exec(mcpUrl)?.[1] ?? "(no org segment in MCP URL)";
        ctx.rec.expect(orgId, "the MCP URL is org-scoped").toMatch(/^org_/);
        ctx.rec
          .expect(installCommand, "the install command references the same org")
          .toContain(orgId);
      });
    }),
);
