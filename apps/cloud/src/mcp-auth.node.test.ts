import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

import {
  McpJwtVerificationError,
  verifyMcpAccessToken,
} from "./mcp-auth";

const issuer = "https://test-authkit.example.com";
const resource = "https://test-resource.example.com/mcp";
const otherResource = "https://other-resource.example.com/mcp";

const makeVerifier = async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key" }] });
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT({ org_id: "org_test", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setSubject("user_test")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  return { jwks, sign };
};

describe("MCP AuthKit token verification", () => {
  it.effect("rejects a valid AuthKit token issued for a different MCP resource", () =>
    Effect.gen(function* () {
      const { jwks, sign } = yield* Effect.promise(() => makeVerifier());
      const token = yield* Effect.promise(() => sign({ aud: otherResource }));

      const error = yield* Effect.flip(verifyMcpAccessToken(token, jwks, {
        issuer,
        audience: resource,
      }));

      expect(error).toBeInstanceOf(McpJwtVerificationError);
    }),
  );

  it.effect("accepts a valid AuthKit token issued for this MCP resource", () =>
    Effect.gen(function* () {
      const { jwks, sign } = yield* Effect.promise(() => makeVerifier());
      const token = yield* Effect.promise(() => sign({ aud: resource }));

      const verified = yield* verifyMcpAccessToken(token, jwks, {
        issuer,
        audience: resource,
      });

      expect(verified).toEqual({
        accountId: "user_test",
        organizationId: "org_test",
      });
    }),
  );
});
