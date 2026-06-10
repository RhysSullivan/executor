// Cross-target (browser): the multi-method auth UX, end to end through the
// real web UI. A live no-auth MCP test server (in this process — the target's
// dev server probes it over loopback) seeds the add flow's method list with
// the detected method; the user declares an API key method alongside it via
// "+ Add method"; after adding, the integration's connect modal offers BOTH
// methods. The session video + per-step screenshots are the artifact.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";

import { scenario } from "../src/scenario";

scenario(
  "Auth methods · the add flow declares an API key alongside the detected method",
  { needs: ["browser"] },
  (ctx) =>
    Effect.scoped(
      Effect.gen(function* () {
        // An OPEN server: the probe connects without auth, so the method list
        // seeds with the detected "no authentication" row — the case where
        // the server declares nothing but the user knows better.
        const server = yield* serveMcpServer(() => makeGreetingMcpServer());
        const identity = yield* ctx.target.newIdentity();

        yield* ctx.browser.session(identity, async ({ page, step }) => {
          await step("Open the add-MCP flow pointed at the server", async () => {
            await page.goto(`/integrations/add/mcp?url=${encodeURIComponent(server.endpoint)}`, {
              waitUntil: "networkidle",
            });
            // The URL auto-probes (debounced); the method list appears once
            // the probe lands.
            await page.getByText("How does this server authenticate?").waitFor();
          });

          await step("The probe seeded the detected method", async () => {
            await page.getByText("Method 1 · Detected").waitFor();
          });

          await step("Declare an API key method alongside it", async () => {
            await page.getByRole("button", { name: "Add method" }).click();
            await page.getByText("Method 2").waitFor();
            // The new row opens on the API key editor with the standard
            // Authorization-header placement prefilled.
            const headerName = page.getByPlaceholder("Authorization").last();
            await headerName.waitFor();
          });

          await step("Add the source with both methods", async () => {
            await page.getByRole("button", { name: "Add source" }).click();
            // onComplete routes to the new integration's detail hub.
            await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
            await page.getByText("Connections").first().waitFor();
          });

          await step("The connect modal offers both methods", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("tab", { name: "No authentication" }).waitFor();
            await page.getByRole("tab", { name: "API key (Authorization)" }).waitFor();
          });

          const tabs = await page.getByRole("tab").allInnerTexts();
          expect(tabs.join(", "), "both declared methods are selectable").toContain(
            "No authentication",
          );
          expect(tabs.join(", ")).toContain("API key (Authorization)");
        });
      }),
    ),
);
