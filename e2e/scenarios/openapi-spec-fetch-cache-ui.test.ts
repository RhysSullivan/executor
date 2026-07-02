// Cross-target (browser): the spec-fetch cache, driven through the real UI.
// The API-surface twin (openapi-spec-fetch-cache.test.ts) pins the same
// contract headlessly; this one exists so the journey is watchable — the
// session video + trace show the add form analyzing a pasted URL, the
// integration landing, and an Edit → re-fetch-on-save refresh — while the
// counting spec server proves what the network actually did underneath:
//   - the whole add journey (the form's debounced analyze + the submit)
//     downloads the spec ONCE,
//   - the refresh consults the server but 304s instead of re-downloading.
// Skips on targets without a browser surface (selfhost today).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Cached Ping API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com", description: "Production" }],
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Return a pong",
        responses: { "200": { description: "pong" } },
      },
    },
  },
});

/** A real 127.0.0.1 spec host with a strong ETag and a request ledger —
 *  the ground truth the video's UI journey is asserted against. Non-spec
 *  paths (the add flow's OAuth discovery probes) 404 outside the count. */
const serveCountingSpec = (body: string) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly downloads: () => number;
      readonly notModified: () => number;
      readonly close: () => void;
    }>((resume) => {
      let downloads = 0;
      let notModified = 0;
      const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
      const server = createServer((request, response) => {
        if (!request.url?.startsWith("/spec.json")) {
          response.writeHead(404);
          response.end();
          return;
        }
        if (request.headers["if-none-match"] === etag) {
          notModified += 1;
          response.writeHead(304, { etag });
          response.end();
          return;
        }
        downloads += 1;
        response.writeHead(200, { "content-type": "application/json", etag });
        response.end(body);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/spec.json`,
            downloads: () => downloads,
            notModified: () => notModified,
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

scenario(
  "OpenAPI · adding a spec by URL in the UI downloads it once and Edit → re-fetch 304s",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const identity = yield* target.newIdentity();
      const specServer = yield* serveCountingSpec(pingSpec);
      const name = `Cache Demo ${randomBytes(3).toString("hex")}`;

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the Add OpenAPI source form", async () => {
          await page.goto("/integrations/add/openapi", { waitUntil: "networkidle" });
          await page.getByPlaceholder("https://api.example.com/openapi.json").waitFor();
        });

        await step("Paste the spec URL — the form analyzes it (first download)", async () => {
          await page.getByPlaceholder("https://api.example.com/openapi.json").fill(specServer.url);
          // The debounced analyze fetches and previews the spec.
          await page.getByRole("button", { name: "Add integration" }).waitFor({ timeout: 20_000 });
        });

        await step("Name it and add the integration", async () => {
          const nameInput = page.getByLabel("Name", { exact: true });
          if (await nameInput.isVisible().catch(() => false)) {
            await nameInput.fill(name);
          }
          await page.getByRole("button", { name: "Add integration" }).click();
          await page.waitForURL(/\/integrations\/(?!add\b)[^/?]+$/, { timeout: 30_000 });
          await page.getByText("Connections").first().waitFor();
        });

        await step("The whole add journey cost exactly one spec download", async () => {
          // The form's analyze already fetched it; addSpec on the server reused
          // the cached copy instead of re-downloading.
          expect(specServer.downloads(), "one download across analyze + add").toBe(1);
        });

        await step("Open Edit and stage a re-fetch of the spec", async () => {
          await page.getByRole("button", { name: "Edit" }).click();
          await page.getByText("Update spec").waitFor({ timeout: 10_000 });
          await page.getByText("Re-fetch the spec on save").click();
        });

        await step("Save — the refresh revalidates (304) instead of re-downloading", async () => {
          await page.getByRole("button", { name: "Save", exact: true }).click();
          await page.getByText("Update spec").waitFor({ state: "hidden", timeout: 30_000 });
        });

        await step("The server saw a conditional request, not a second download", async () => {
          expect(specServer.notModified(), "the refresh got a bodyless 304").toBe(1);
          expect(specServer.downloads(), "still exactly one full download").toBe(1);
        });
      });
    }),
  ),
);
