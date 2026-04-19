import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./server/main", () => ({
  getServerHandlers: async () => ({
    api: {
      handler: async () => new Response("ok"),
      dispose: async () => {},
    },
    mcp: {
      handleRequest: async () => new Response("ok"),
      close: async () => {},
    },
  }),
}));

import { startServer, type ServerInstance } from "./serve";

let clientDir: string;
let server: ServerInstance | null = null;

const startTestServer = async (): Promise<string> => {
  server = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    clientDir,
  });
  return `http://127.0.0.1:${server.port}`;
};

beforeEach(() => {
  clientDir = mkdtempSync(join(tmpdir(), "exec-local-serve-"));
  mkdirSync(join(clientDir, "assets"), { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<!doctype html><html><body>index-shell</body></html>");
  writeFileSync(join(clientDir, "assets", "app.js"), "console.log('ok')");
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  rmSync(clientDir, { recursive: true, force: true });
});

describe("startServer static/SPA routing", () => {
  it("returns 404 for missing asset-like paths", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/assets/missing.js`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("falls back to index.html for extension-less SPA routes", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/sources/add`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("index-shell");
  });
});
