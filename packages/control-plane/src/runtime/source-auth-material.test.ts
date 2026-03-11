import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import {
  SourceIdSchema,
  WorkspaceIdSchema,
  type Source,
} from "#schema";

import { resolveSourceAuthMaterial } from "./source-auth-material";

const makeSource = (overrides: Partial<Source> = {}): Source => ({
  id: SourceIdSchema.make("src_tool_artifacts"),
  workspaceId: WorkspaceIdSchema.make("ws_tool_artifacts"),
  name: "GitHub",
  kind: "openapi",
  endpoint: "https://api.github.com",
  status: "connected",
  enabled: true,
  namespace: "github",
  bindingVersion: 1,
  binding: {
    specUrl: "https://api.github.com/openapi.json",
    defaultHeaders: null,
  },
  importAuthPolicy: "reuse_runtime",
  importAuth: { kind: "none" },
  auth: { kind: "none" },
  sourceHash: null,
  lastError: null,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

describe("source-auth-material", () => {
  describe("resolveSourceAuthMaterial", () => {
    it("returns empty headers for auth.kind none", async () => {
      const auth = await Effect.runPromise(resolveSourceAuthMaterial({
        source: makeSource({
          auth: { kind: "none" },
        }),
        resolveSecretMaterial: () => Effect.die("should not be called"),
      }));

      expect(auth).toEqual({ headers: {} });
    });

    it("resolves bearer auth headers from the configured token ref", async () => {
      const calls: string[] = [];

      const auth = await Effect.runPromise(resolveSourceAuthMaterial({
        source: makeSource({
          auth: {
            kind: "bearer",
            headerName: "X-Api-Key",
            prefix: "Token ",
            token: {
              providerId: "postgres",
              handle: "sec_bearer",
            },
          },
        }),
        resolveSecretMaterial: ({ ref }) => {
          calls.push(`${ref.providerId}:${ref.handle}`);
          return Effect.succeed("resolved-bearer-token");
        },
      }));

      expect(calls).toEqual(["postgres:sec_bearer"]);
      expect(auth).toEqual({
        headers: {
          "X-Api-Key": "Token resolved-bearer-token",
        },
      });
    });

    it("uses the oauth access token ref and ignores the refresh token", async () => {
      const calls: string[] = [];

      const auth = await Effect.runPromise(resolveSourceAuthMaterial({
        source: makeSource({
          kind: "graphql",
          endpoint: "https://example.com/graphql",
          binding: {
            defaultHeaders: null,
          },
          auth: {
            kind: "oauth2",
            headerName: "Authorization",
            prefix: "Bearer ",
            accessToken: {
              providerId: "postgres",
              handle: "sec_access",
            },
            refreshToken: {
              providerId: "postgres",
              handle: "sec_refresh",
            },
          },
        }),
        resolveSecretMaterial: ({ ref }) => {
          calls.push(`${ref.providerId}:${ref.handle}`);
          return Effect.succeed("resolved-access-token");
        },
      }));

      expect(calls).toEqual(["postgres:sec_access"]);
      expect(auth).toEqual({
        headers: {
          Authorization: "Bearer resolved-access-token",
        },
      });
    });
  });
});
