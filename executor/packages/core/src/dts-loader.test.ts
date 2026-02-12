import { expect, test } from "bun:test";
import { loadSourceDtsByUrl } from "./dts-loader";

test("loadSourceDtsByUrl fetches declarations for each source key", async () => {
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requestCount += 1;
      return new Response("export interface operations { ping: {} }", {
        headers: { "content-type": "text/plain" },
      });
    },
  });

  try {
    const url = `http://127.0.0.1:${server.port}/types.d.ts`;

    const first = await loadSourceDtsByUrl({
      "openapi:one": url,
      "openapi:two": url,
    });
    const second = await loadSourceDtsByUrl({
      "openapi:one": url,
    });

    expect(first["openapi:one"]).toContain("interface operations");
    expect(first["openapi:two"]).toContain("interface operations");
    expect(second["openapi:one"]).toContain("interface operations");
    expect(requestCount).toBe(3);
  } finally {
    server.stop(true);
  }
});

test("loadSourceDtsByUrl skips sources that fail to download", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/fail.d.ts") {
        return new Response("nope", { status: 500 });
      }
      return new Response("export interface operations { pong: {} }", {
        headers: { "content-type": "text/plain" },
      });
    },
  });

  try {
    const okUrl = `http://127.0.0.1:${server.port}/ok.d.ts`;
    const failUrl = `http://127.0.0.1:${server.port}/fail.d.ts`;

    const loaded = await loadSourceDtsByUrl({
      "openapi:ok": okUrl,
      "openapi:fail": failUrl,
    });

    expect(loaded["openapi:ok"]).toContain("interface operations");
    expect(loaded["openapi:fail"]).toBeUndefined();
  } finally {
    server.stop(true);
  }
});
