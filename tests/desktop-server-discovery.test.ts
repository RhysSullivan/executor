import { describe, expect, it } from "@effect/vitest";
import { join } from "node:path";
import {
  discoverExistingLocalServer,
  discoverPointerCandidates,
} from "../apps/desktop/src/main/server-discovery";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("desktop server discovery", () => {
  it("builds candidates from live same-scope daemon pointers", async () => {
    const dataDir = "/Users/example/.executor-global";
    const pointer = {
      version: 1,
      hostname: "localhost",
      port: 4788,
      pid: 12345,
      startedAt: "2026-05-13T00:00:00.000Z",
      scopeId: "scope:/Users/example/.executor-global-global",
      scopeDir: "/Users/example/.executor-global",
      token: "tok_123",
    };

    const candidates = await discoverPointerCandidates({
      scopeDir: "/Users/example/.executor-global",
      dataDir,
      readDirImpl: (async () => [
        "daemon-active-localhost-matching.json",
        "daemon-localhost-4788.json",
      ]) as typeof import("node:fs/promises").readdir,
      readFileImpl: (async (path) => {
        expect(path).toBe(join(dataDir, "daemon-active-localhost-matching.json"));
        return JSON.stringify(pointer);
      }) as typeof import("node:fs/promises").readFile,
      isPidAliveImpl: (pid) => pid === 12345,
    });

    expect(candidates).toEqual([{ baseUrl: "http://127.0.0.1:4788" }]);
  });

  it("ignores stale, malformed, or different-scope daemon pointers", async () => {
    const dataDir = "/Users/example/.executor-global";
    const pointers: Record<string, unknown> = {
      "daemon-active-localhost-dead.json": {
        version: 1,
        hostname: "localhost",
        port: 4788,
        pid: 999,
        scopeId: "scope:/Users/example/.executor-global-global",
        scopeDir: "/Users/example/.executor-global",
      },
      "daemon-active-localhost-other-scope.json": {
        version: 1,
        hostname: "localhost",
        port: 4789,
        pid: 12345,
        scopeId: "scope:/tmp/other",
        scopeDir: "/tmp/other",
      },
      "daemon-active-localhost-bad.json": { version: 1 },
    };

    const candidates = await discoverPointerCandidates({
      scopeDir: "/Users/example/.executor-global",
      dataDir,
      readDirImpl: (async () => Object.keys(pointers)) as typeof import("node:fs/promises").readdir,
      readFileImpl: (async (path) =>
        JSON.stringify(
          pointers[String(path).split("/").at(-1) ?? ""],
        )) as typeof import("node:fs/promises").readFile,
      isPidAliveImpl: (pid) => pid === 12345,
    });

    expect(candidates).toEqual([]);
  });

  it("attaches to the first unauthenticated local server with the desktop scope", async () => {
    const calls: Array<string> = [];
    const match = await discoverExistingLocalServer({
      scopeDir: "/Users/example/.executor-global",
      candidates: [{ baseUrl: "http://127.0.0.1:4788" }, { baseUrl: "http://127.0.0.1:4789" }],
      fetchImpl: (async (input) => {
        calls.push(String(input));
        return jsonResponse(200, {
          id: "scope:/Users/example/.executor-global-global",
          name: "/Users/example/.executor-global",
          dir: "/Users/example/.executor-global",
        });
      }) as typeof fetch,
    });

    expect(match).toEqual({
      baseUrl: "http://127.0.0.1:4788",
      port: 4788,
      scopeDir: "/Users/example/.executor-global",
    });
    expect(calls).toEqual(["http://127.0.0.1:4788/api/scope"]);
  });

  it("skips authenticated or different-scope local servers", async () => {
    const match = await discoverExistingLocalServer({
      scopeDir: "/Users/example/.executor-global",
      candidates: [
        { baseUrl: "http://127.0.0.1:4788" },
        { baseUrl: "http://127.0.0.1:4790" },
        { baseUrl: "http://127.0.0.1:4791" },
      ],
      fetchImpl: (async (input) => {
        const url = String(input);
        if (url.includes(":4788/")) return new Response("Unauthorized", { status: 401 });
        if (url.includes(":4790/")) {
          return jsonResponse(200, {
            id: "scope:/tmp/other",
            name: "/tmp/other",
            dir: "/tmp/other",
          });
        }
        return jsonResponse(200, {
          id: "scope:/Users/example/.executor-global-global",
          name: "/Users/example/.executor-global",
          dir: "/Users/example/.executor-global/",
        });
      }) as typeof fetch,
    });

    expect(match).toEqual({
      baseUrl: "http://127.0.0.1:4791",
      port: 4791,
      scopeDir: "/Users/example/.executor-global/",
    });
  });

  it("returns null when no compatible server is found", async () => {
    const match = await discoverExistingLocalServer({
      scopeDir: "/Users/example/.executor-global",
      candidates: [{ baseUrl: "http://127.0.0.1:4788" }],
      fetchImpl: (async () => new Response("Not Found", { status: 404 })) as typeof fetch,
    });

    expect(match).toBeNull();
  });
});
