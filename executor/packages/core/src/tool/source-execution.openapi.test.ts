import { afterEach, expect, test } from "bun:test";
import { executeOpenApiRequest, type OpenApiRequestRunSpec } from "./source-execution";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("executeOpenApiRequest serializes structured OpenAPI input buckets", async () => {
  let capturedUrl = "";
  let capturedRequest: RequestInit | undefined;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = typeof url === "string"
      ? url
      : url instanceof URL
        ? url.toString()
        : url.url;
    capturedRequest = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as unknown as typeof fetch;

  const runSpec: OpenApiRequestRunSpec = {
    baseUrl: "https://api.example.com",
    method: "post",
    pathTemplate: "/widgets/{id}",
    authHeaders: { authorization: "Bearer static" },
    parameters: [
      { name: "id", in: "path", required: true },
      { name: "fields", in: "query", style: "form", explode: false },
      { name: "expand", in: "query", style: "deepObject" },
      { name: "x-trace-id", in: "header" },
      { name: "session", in: "cookie" },
    ],
  };

  const result = await executeOpenApiRequest(
    runSpec,
    {
      path: { id: "wid_123" },
      query: {
        fields: ["name", "status"],
        expand: { owner: true },
      },
      headers: { "x-trace-id": "trace-1" },
      cookie: { session: "abc" },
      body: { name: "Widget" },
    },
    { "x-api-key": "secret" },
  );

  expect(result.isOk()).toBe(true);
  expect(capturedUrl).toContain("/widgets/wid_123");
  expect(capturedUrl).toContain("fields=name%2Cstatus");
  expect(capturedUrl).toContain("expand%5Bowner%5D=true");
  expect(capturedRequest?.headers).toEqual({
    authorization: "Bearer static",
    "x-api-key": "secret",
    "x-trace-id": "trace-1",
    Cookie: "session=abc",
    "content-type": "application/json",
  });
  expect(capturedRequest?.body).toBe(JSON.stringify({ name: "Widget" }));
});

test("executeOpenApiRequest returns validation error when required path parameter is missing", async () => {
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const runSpec: OpenApiRequestRunSpec = {
    baseUrl: "https://api.example.com",
    method: "get",
    pathTemplate: "/widgets/{id}",
    authHeaders: {},
    parameters: [
      { name: "id", in: "path", required: true },
    ],
  };

  const result = await executeOpenApiRequest(runSpec, { path: {} });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("Missing required path parameter 'id'");
  }
  expect(fetchCalled).toBe(false);
});
