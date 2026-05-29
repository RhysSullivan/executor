import { describe, expect, it } from "@effect/vitest";

import {
  apiBaseUrlForServerOrigin,
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  originFromApiBaseUrl,
  resolveBrowserExecutorServerConnection,
} from "./server-connection";

describe("Executor server connection", () => {
  it("normalizes server origins and API base URLs", () => {
    expect(normalizeExecutorServerOrigin("localhost:4788/")).toBe("http://localhost:4788");
    expect(normalizeExecutorServerOrigin("http://localhost:4788/api")).toBe(
      "http://localhost:4788",
    );
    expect(apiBaseUrlForServerOrigin("http://localhost:4788")).toBe("http://localhost:4788/api");
    expect(originFromApiBaseUrl("http://localhost:4788/api")).toBe("http://localhost:4788");
  });

  it("builds a stable connection from an explicit server origin", () => {
    const connection = normalizeExecutorServerConnection({
      origin: "https://executor.example",
      displayName: "Remote Executor",
    });

    expect(connection).toMatchObject({
      kind: "http",
      key: "http:https://executor.example",
      origin: "https://executor.example",
      apiBaseUrl: "https://executor.example/api",
      displayName: "Remote Executor",
    });
  });

  it("preserves desktop sidecar compatibility from the legacy window bridge", () => {
    const connection = resolveBrowserExecutorServerConnection({
      locationOrigin: "https://ignored.example",
      bridge: {
        baseUrl: "http://127.0.0.1:4789",
        authPassword: "secret",
      },
    });

    expect(connection.kind).toBe("desktop-sidecar");
    expect(connection.origin).toBe("http://127.0.0.1:4789");
    expect(connection.apiBaseUrl).toBe("http://127.0.0.1:4789/api");
    expect(getExecutorServerAuthorizationHeader(connection)).toBe("Basic ZXhlY3V0b3I6c2VjcmV0");
  });
});
