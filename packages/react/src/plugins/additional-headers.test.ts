import { describe, expect, it } from "@effect/vitest";

import type { HeaderState } from "./secret-header-auth";
import {
  mergeHeaders,
  partitionHeaders,
  validateHeaderConfiguration,
  type PlainHeader,
} from "./additional-headers";

describe("additional-headers helpers", () => {
  it("partitions mixed header values into auth and additional headers", () => {
    const result = partitionHeaders({
      Authorization: { secretId: "token", prefix: "Bearer " },
      "X-Workspace": "team-123",
    });

    expect(result.authHeaders).toEqual([
      {
        name: "Authorization",
        secretId: "token",
        prefix: "Bearer ",
        presetKey: "bearer",
      },
    ]);
    expect(result.additionalHeaders).toEqual([{ name: "X-Workspace", value: "team-123" }]);
  });

  it("merges auth and additional headers back into one payload", () => {
    const authHeaders: HeaderState[] = [
      {
        name: "Authorization",
        secretId: "token",
        prefix: "Bearer ",
        presetKey: "bearer",
      },
    ];
    const additionalHeaders: PlainHeader[] = [{ name: "X-Workspace", value: "team-123" }];

    expect(mergeHeaders(authHeaders, additionalHeaders)).toEqual({
      Authorization: { secretId: "token", prefix: "Bearer " },
      "X-Workspace": "team-123",
    });
  });

  it("rejects duplicate header names case-insensitively", () => {
    const error = validateHeaderConfiguration({
      authHeaders: [{ name: "Authorization", secretId: "token" }],
      additionalHeaders: [{ name: " authorization ", value: "shadow" }],
    });

    expect(error).toBe("Header names must be unique across authentication and additional headers.");
  });

  it("rejects manual authorization headers when OAuth manages auth", () => {
    const error = validateHeaderConfiguration({
      authHeaders: [],
      additionalHeaders: [{ name: "Authorization", value: "Bearer shadow" }],
      reserveAuthorization: true,
    });

    expect(error).toBe("Authorization header is managed by OAuth and can't be set manually.");
  });
});
