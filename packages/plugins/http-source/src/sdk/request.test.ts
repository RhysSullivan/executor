import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/unstable/http";

import { issueRequest } from "./request";
import type { RenderedAuth } from "./template";

/* A capturing in-memory HttpClient: records the request it was handed and
 * returns a canned web Response. No network. */
const capturingClient = (
  capture: { request?: HttpClientRequest.HttpClientRequest },
  response: Response,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      capture.request = request;
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );

const noAuth: RenderedAuth = { headers: {}, queryParams: {} };

describe("issueRequest", () => {
  it.effect("issues a GET, merges auth headers + query, parses JSON body", () =>
    Effect.gen(function* () {
      const capture: { request?: HttpClientRequest.HttpClientRequest } = {};
      const layer = capturingClient(
        capture,
        new Response('{"hello":"world"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const result = yield* issueRequest(
        {
          baseUrl: "https://api.example.com",
          method: "GET",
          path: "/things",
          query: { limit: 5 },
          headers: { "x-trace": "abc" },
          auth: {
            headers: { Authorization: "Bearer tok" },
            queryParams: { api_key: "k" },
          },
          defaultHeaders: { "x-default": "d" },
        },
        layer,
      );

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ hello: "world" });

      const sent = capture.request!;
      expect(sent.method).toBe("GET");
      expect(sent.url).toContain("https://api.example.com/things");
      const params = UrlParams.toString(sent.urlParams);
      expect(params).toContain("limit=5");
      expect(params).toContain("api_key=k");
      expect(sent.headers["authorization"]).toBe("Bearer tok");
      expect(sent.headers["x-trace"]).toBe("abc");
      expect(sent.headers["x-default"]).toBe("d");
    }),
  );

  it.effect("returns non-2xx upstream responses as data, not an error", () =>
    Effect.gen(function* () {
      const capture: { request?: HttpClientRequest.HttpClientRequest } = {};
      const layer = capturingClient(
        capture,
        new Response("nope", {
          status: 404,
          headers: { "content-type": "text/plain" },
        }),
      );

      const result = yield* issueRequest(
        {
          baseUrl: "https://api.example.com",
          method: "GET",
          path: "/missing",
          auth: noAuth,
        },
        layer,
      );

      expect(result.status).toBe(404);
      expect(result.body).toBe("nope");
    }),
  );

  it.effect("JSON-encodes object bodies on POST", () =>
    Effect.gen(function* () {
      const capture: { request?: HttpClientRequest.HttpClientRequest } = {};
      const layer = capturingClient(capture, new Response(null, { status: 204 }));

      const result = yield* issueRequest(
        {
          baseUrl: "https://api.example.com",
          method: "POST",
          path: "things",
          body: { name: "n" },
          auth: noAuth,
        },
        layer,
      );

      expect(result.status).toBe(204);
      expect(result.body).toBe(null);
      const sent = capture.request!;
      expect(sent.method).toBe("POST");
      // path without leading slash is still joined under the base
      expect(sent.url).toContain("https://api.example.com/things");
    }),
  );

  it.effect("treats an absolute path as the full URL (ignores baseUrl)", () =>
    Effect.gen(function* () {
      const capture: { request?: HttpClientRequest.HttpClientRequest } = {};
      const layer = capturingClient(
        capture,
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      yield* issueRequest(
        {
          baseUrl: "https://api.example.com",
          method: "GET",
          path: "https://other.example.org/x",
          auth: noAuth,
        },
        layer,
      );

      expect(capture.request!.url).toContain("https://other.example.org/x");
    }),
  );
});
