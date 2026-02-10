import { expect, test } from "bun:test";
import { clearDtsUrlCache, loadSourceDtsByUrlCached } from "./dts_loader";

test("loadSourceDtsByUrlCached reuses cached URL fetches", async () => {
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
    clearDtsUrlCache();
    const url = `http://127.0.0.1:${server.port}/types.d.ts`;

    const first = await loadSourceDtsByUrlCached({
      "openapi:one": url,
      "openapi:two": url,
    });
    const second = await loadSourceDtsByUrlCached({
      "openapi:one": url,
    });

    expect(first["openapi:one"]).toContain("interface operations");
    expect(first["openapi:two"]).toContain("interface operations");
    expect(second["openapi:one"]).toContain("interface operations");
    expect(requestCount).toBe(1);
  } finally {
    server.stop(true);
    clearDtsUrlCache();
  }
});

test("loadSourceDtsByUrlCached respects ttl expiration", async () => {
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
    clearDtsUrlCache();
    const url = `http://127.0.0.1:${server.port}/types.d.ts`;

    await loadSourceDtsByUrlCached({ "openapi:one": url }, { ttlMs: 5 });
    await Bun.sleep(20);
    await loadSourceDtsByUrlCached({ "openapi:one": url }, { ttlMs: 5 });

    expect(requestCount).toBe(2);
  } finally {
    server.stop(true);
    clearDtsUrlCache();
  }
});
