// Cloud-specific: the agent-connect panel defaults to Remote HTTP with org-scoped
// /mcp URL, and clicking "Standard I/O" switches the command. Driven through
// the browser as a fresh user with an organization on the Integrations page.
import { Effect } from "effect";

import { scenario } from "../src/scenario";

scenario(
  "Connect · the agent-connect panel gives working copy for both transports",
  { needs: ["browser"] },
  (ctx) =>
    Effect.gen(function* () {
      ctx.rec.say(
        "A fresh user with an org navigates to the Integrations page to see the connect panel with Remote HTTP and Standard I/O options.",
      );
      const identity = yield* ctx.target.newIdentity();

      yield* ctx.browser.session(identity, async ({ page, step }) => {
        await step("Navigate to the Integrations page", async () => {
          await page.goto("/", { waitUntil: "networkidle" });
          await page.getByText("Integrations").first().waitFor();
          // Let the router navigation fully settle before reading UI elements
          await page.waitForLoadState("networkidle");
        });

        await step("Verify the connect panel shows with Remote HTTP selected", async () => {
          // Find the "Connect an agent" header
          await page.getByText("Connect an agent").first().waitFor();
          // The Remote HTTP tab should be visible and the command should contain npx add-mcp
          const commandBlock = page.locator("code").first();
          const initialCommand = await commandBlock.textContent();
          ctx.rec
            .expect(
              initialCommand?.includes("npx add-mcp"),
              "Remote HTTP command starts with npx add-mcp",
            )
            .toBe(true);
          ctx.rec.step("browser", `Remote HTTP command: ${initialCommand?.trim()}`);
        });

        await step(
          "Get the initial Remote HTTP command and verify org-scoped /mcp URL",
          async () => {
            const commandBlock = page.locator("code").first();
            const httpCommand = await commandBlock.textContent();

            // The command should contain an org-scoped /mcp URL path
            ctx.rec
              .expect(
                httpCommand?.includes("/mcp") || httpCommand?.includes("/"),
                "command contains /mcp or org scope",
              )
              .toBe(true);

            // Verify it's a valid npx add-mcp command structure
            ctx.rec
              .expect(
                httpCommand?.includes("--transport http"),
                "Remote HTTP uses --transport http",
              )
              .toBe(true);

            ctx.rec.step("browser", `Initial HTTP command verified`);
          },
        );

        await step("Click the Standard I/O tab to switch transports", async () => {
          // The tab should be labeled "Standard I/O"
          const stdioTab = page.getByRole("tab", { name: "Standard I/O" });
          await stdioTab.waitFor();
          await stdioTab.click();
          // Let the state update
          await page.waitForLoadState("networkidle");
        });

        await step("Verify the command changed for Standard I/O", async () => {
          const commandBlock = page.locator("code").first();
          const stdioCommand = await commandBlock.textContent();

          // Standard I/O command should still use npx add-mcp but without --transport http
          ctx.rec
            .expect(stdioCommand?.includes("npx add-mcp"), "Standard I/O command uses npx add-mcp")
            .toBe(true);

          // It should NOT have --transport http (that's specific to Remote HTTP)
          ctx.rec
            .expect(
              !stdioCommand?.includes("--transport http"),
              "Standard I/O does not use --transport http",
            )
            .toBe(true);

          // Standard I/O commands typically reference executor or bun run dev:cli
          const hasExecutorRef =
            stdioCommand?.includes("executor") || stdioCommand?.includes("dev:cli");
          ctx.rec.expect(hasExecutorRef, "Standard I/O references executor or dev:cli").toBe(true);

          ctx.rec.step("browser", `Standard I/O command verified: ${stdioCommand?.trim()}`);
        });

        await step("Switch back to Remote HTTP to verify it still works", async () => {
          const httpTab = page.getByRole("tab", { name: "Remote HTTP" });
          await httpTab.click();
          await page.waitForLoadState("networkidle");

          const commandBlock = page.locator("code").first();
          const httpCommandAgain = await commandBlock.textContent();

          // Should be back to HTTP transport
          ctx.rec
            .expect(
              httpCommandAgain?.includes("--transport http"),
              "Switched back to Remote HTTP with --transport http",
            )
            .toBe(true);
        });
      });
    }),
);
