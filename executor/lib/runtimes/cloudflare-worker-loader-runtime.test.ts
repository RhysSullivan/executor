import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dispatchCodeWithCloudflareWorkerLoader } from "./cloudflare_worker_loader_runtime";

let fakeHostServer: ReturnType<typeof Bun.serve>;
let fakeCallbackServer: ReturnType<typeof Bun.serve>;

const AUTH_TOKEN = "test-sandbox-token";
const CALLBACK_TOKEN = "test-callback-token";

let hostResponseStatus = 202;
let hostResponseBody: Record<string, unknown> = { accepted: true, dispatchId: "dispatch_test" };
type HostRequestBody = {
  taskId: string;
  code: string;
  timeoutMs: number;
  callback: { convexUrl: string; internalSecret: string };
};

let lastHostRequestBody: HostRequestBody | null = null;

beforeAll(() => {
  fakeCallbackServer = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });

  fakeHostServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/runs" || req.method !== "POST") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${AUTH_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      lastHostRequestBody = await req.json();
      return Response.json(hostResponseBody, { status: hostResponseStatus });
    },
  });

  process.env.CLOUDFLARE_SANDBOX_RUN_URL = `http://127.0.0.1:${fakeHostServer.port}/v1/runs`;
  process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN = AUTH_TOKEN;
  process.env.CONVEX_SITE_URL = `http://127.0.0.1:${fakeCallbackServer.port}`;
  process.env.EXECUTOR_INTERNAL_TOKEN = CALLBACK_TOKEN;
  process.env.CLOUDFLARE_SANDBOX_REQUEST_TIMEOUT_MS = "10000";
});

afterAll(() => {
  fakeHostServer?.stop(true);
  fakeCallbackServer?.stop(true);
  delete process.env.CLOUDFLARE_SANDBOX_RUN_URL;
  delete process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN;
  delete process.env.CONVEX_SITE_URL;
  delete process.env.EXECUTOR_INTERNAL_TOKEN;
  delete process.env.CLOUDFLARE_SANDBOX_REQUEST_TIMEOUT_MS;
});

describe("cloudflare worker loader dispatch", () => {
  test("dispatches run request and returns accepted response", async () => {
    hostResponseStatus = 202;
    hostResponseBody = { accepted: true, dispatchId: "dispatch_abc" };
    lastHostRequestBody = null;

    const result = await dispatchCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `console.log("hello");`,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accepted).toBe(true);
      expect(result.dispatchId).toBe("dispatch_abc");
    }

    expect(lastHostRequestBody).not.toBeNull();
    const requestBody = lastHostRequestBody as unknown as HostRequestBody;
    expect(requestBody.callback.convexUrl).toContain(String(fakeCallbackServer.port));
    expect(requestBody.callback.internalSecret).toBe(CALLBACK_TOKEN);
  });

  test("transpiles TypeScript before dispatching", async () => {
    hostResponseStatus = 202;
    hostResponseBody = { accepted: true, dispatchId: "dispatch_ts" };
    lastHostRequestBody = null;

    const result = await dispatchCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `
        interface User { name: string }
        const user: User = { name: "Ada" };
        console.log(user.name);
      `,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(lastHostRequestBody).not.toBeNull();
    const requestBody = lastHostRequestBody as unknown as HostRequestBody;
    expect(requestBody.code.includes("interface User")).toBe(false);
    expect(requestBody.code.includes("const user")).toBe(true);
  });

  test("fails when host does not accept dispatch", async () => {
    hostResponseStatus = 500;
    hostResponseBody = { error: "host failure" };

    const result = await dispatchCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `console.log("x");`,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("500");
    }
  });

  test("reports TypeScript transpile errors", async () => {
    const result = await dispatchCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `const x: = 5;`,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("TypeScript transpile error");
    }
  });
});

describe("runtime catalog", () => {
  test("isKnownRuntimeId recognizes both runtimes", async () => {
    const {
      isKnownRuntimeId,
      LOCAL_BUN_RUNTIME_ID,
      CLOUDFLARE_WORKER_LOADER_RUNTIME_ID,
    } = await import("./runtime_catalog");

    expect(isKnownRuntimeId(LOCAL_BUN_RUNTIME_ID)).toBe(true);
    expect(isKnownRuntimeId(CLOUDFLARE_WORKER_LOADER_RUNTIME_ID)).toBe(true);
    expect(isKnownRuntimeId("unknown-runtime")).toBe(false);
  });

  test("isCloudflareWorkerLoaderConfigured checks env vars", async () => {
    const { isCloudflareWorkerLoaderConfigured } = await import("./runtime_catalog");
    expect(isCloudflareWorkerLoaderConfigured()).toBe(true);
  });

  test("getCloudflareWorkerLoaderConfig reads env vars", async () => {
    const { getCloudflareWorkerLoaderConfig } = await import("./runtime_catalog");
    const config = getCloudflareWorkerLoaderConfig();

    expect(config.runUrl).toContain("/v1/runs");
    expect(config.authToken).toBe(AUTH_TOKEN);
    expect(config.callbackConvexUrl).toContain(String(fakeCallbackServer.port));
    expect(config.callbackInternalSecret).toBe(CALLBACK_TOKEN);
    expect(config.requestTimeoutMs).toBe(10_000);
  });

  test("prefers CONVEX_URL over CONVEX_SITE_URL for callback RPC", async () => {
    const { getCloudflareWorkerLoaderConfig } = await import("./runtime_catalog");
    const previousConvexUrl = process.env.CONVEX_URL;
    const previousSiteUrl = process.env.CONVEX_SITE_URL;
    try {
      process.env.CONVEX_URL = "https://example-convex-cloud-url.test";
      process.env.CONVEX_SITE_URL = "https://example-convex-site-url.test";

      const config = getCloudflareWorkerLoaderConfig();
      expect(config.callbackConvexUrl).toBe("https://example-convex-cloud-url.test");
    } finally {
      process.env.CONVEX_URL = previousConvexUrl;
      process.env.CONVEX_SITE_URL = previousSiteUrl;
    }
  });
});
