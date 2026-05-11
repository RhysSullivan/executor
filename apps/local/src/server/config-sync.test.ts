import { describe, expect, it } from "@effect/vitest";

import { translateMcpAuth } from "./config-sync";

describe("translateMcpAuth", () => {
  it("returns undefined when no auth is configured", () => {
    expect(translateMcpAuth(undefined)).toBeUndefined();
  });

  it("preserves the kind=none variant", () => {
    expect(translateMcpAuth({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("preserves oauth2 connectionId so the source keeps its OAuth link across boots", () => {
    expect(translateMcpAuth({ kind: "oauth2", connectionId: "mcp-oauth2-linear" })).toEqual({
      kind: "oauth2",
      connectionId: "mcp-oauth2-linear",
    });
  });

  it("strips the secret-public-ref prefix from header auth", () => {
    expect(
      translateMcpAuth({
        kind: "header",
        headerName: "Authorization",
        secret: "secret-public-ref:my-token",
        prefix: "Bearer ",
      }),
    ).toEqual({
      kind: "header",
      headerName: "Authorization",
      secretId: "my-token",
      prefix: "Bearer ",
    });
  });

  it("passes through a raw secret id when no prefix is present", () => {
    expect(
      translateMcpAuth({
        kind: "header",
        headerName: "X-Api-Key",
        secret: "raw-id",
      }),
    ).toEqual({
      kind: "header",
      headerName: "X-Api-Key",
      secretId: "raw-id",
      prefix: undefined,
    });
  });
});
