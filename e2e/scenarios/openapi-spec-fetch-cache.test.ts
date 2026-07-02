// Cross-target: the spec-fetch cache — "we don't re-download a spec we already
// have". A real 127.0.0.1 server serves the spec with a strong ETag and honors
// If-None-Match, counting every request it sees. The observable contract at
// the product boundary is that server's request log:
//   - the add flow (preview, preview again, addSpec) downloads the spec ONCE —
//     the URL-index cache serves the repeats, across separate HTTP requests
//     (on cloud each request is its own executor, so this also proves the
//     index is durable, not in-memory),
//   - updateSpec on an unchanged upstream still hits the server (an explicit
//     refresh must revalidate) but gets a bodyless 304, not a re-download,
//   - updateSpec on a CHANGED upstream busts the cache through the validators
//     and the new tool catalog lands.
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const specV1 = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Cached API", version: "1.0.0" },
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

const specV2 = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Cached API", version: "2.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Return a pong",
        responses: { "200": { description: "pong" } },
      },
    },
    "/widgets": {
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        responses: { "200": { description: "widgets" } },
      },
    },
  },
});

/** A real 127.0.0.1 spec host that serves a strong ETag (the body's SHA-256),
 *  honors `If-None-Match` with a 304, and counts what it saw — the request
 *  ledger the assertions run against. */
const serveCountingSpec = (initial: string) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly setBody: (body: string) => void;
      readonly downloads: () => number;
      readonly notModified: () => number;
      readonly close: () => void;
    }>((resume) => {
      let body = initial;
      let downloads = 0;
      let notModified = 0;
      const server = createServer((request, response) => {
        // Only /spec.json is the spec. Everything else (the add flow's OAuth
        // discovery probes .well-known paths on this host) 404s and stays out
        // of the download count — the assertions are about spec transfers.
        if (!request.url?.startsWith("/spec.json")) {
          response.writeHead(404);
          response.end();
          return;
        }
        const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
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
            setBody: (next: string) => {
              body = next;
            },
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
  "OpenAPI · the add flow downloads a spec once and refresh revalidates instead of re-downloading",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client } = yield* Api;
      const identity = yield* target.newIdentity();
      const apiClient = yield* client(api, identity);

      const slug = `spec-cache-${randomBytes(4).toString("hex")}`;
      const specServer = yield* serveCountingSpec(specV1);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // The add flow as the UI drives it: analyze (debounce can fire it
          // more than once), then add. Three API calls, one download.
          const firstPreview = yield* apiClient.openapi.previewSpec({
            payload: { spec: specServer.url },
          });
          expect(firstPreview.operationCount, "preview sees the v1 spec").toBe(1);
          const secondPreview = yield* apiClient.openapi.previewSpec({
            payload: { spec: specServer.url },
          });
          expect(secondPreview.operationCount, "re-preview still sees v1").toBe(1);
          const added = yield* apiClient.openapi.addSpec({
            payload: {
              spec: { kind: "url", url: specServer.url },
              slug,
              baseUrl: "http://127.0.0.1:59999", // tools are never invoked here
            },
          });
          expect(added.toolCount, "v1 spec has one operation").toBe(1);
          expect(
            specServer.downloads(),
            "preview → preview → add downloaded the spec exactly once",
          ).toBe(1);

          // Explicit refresh with the upstream unchanged: the server must be
          // consulted (a refresh is a freshness demand), but with the stored
          // ETag it answers 304 and nothing is re-downloaded.
          const unchanged = yield* apiClient.openapi.updateSpec({
            params: { slug },
            payload: {},
          });
          expect(unchanged.addedTools, "no tools appeared").toEqual([]);
          expect(unchanged.removedTools, "no tools vanished").toEqual([]);
          expect(specServer.notModified(), "the refresh revalidated and got a 304").toBe(1);
          expect(specServer.downloads(), "an unchanged spec is not re-downloaded").toBe(1);

          // The upstream ships v2: the validators no longer match, the cache
          // busts, and the refreshed catalog lands.
          specServer.setBody(specV2);
          const updated = yield* apiClient.openapi.updateSpec({
            params: { slug },
            payload: {},
          });
          expect(updated.addedTools, "the new operation arrived").toEqual(["widgets.listWidgets"]);
          expect(specServer.downloads(), "the changed spec was downloaded").toBe(2);
          expect(specServer.notModified(), "no spurious 304 for a changed body").toBe(1);
        }),
        apiClient.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
      );
    }),
  ),
);
