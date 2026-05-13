import { HttpServerResponse } from "effect/unstable/http";
import { Effect } from "effect";

import type { McpJwtVerificationError } from "../mcp-auth";

export const CORS_ALLOW_ORIGIN = { "access-control-allow-origin": "*" } as const;

type UnauthorizedAuth = {
  readonly reason: "missing_bearer" | "invalid_token";
  readonly description?: string;
};

const quoteAuthParam = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const bearerChallenge = (auth: UnauthorizedAuth, protectedResourceMetadataUrl: string) => {
  const params =
    auth.reason === "missing_bearer"
      ? [`resource_metadata=${quoteAuthParam(protectedResourceMetadataUrl)}`]
      : [
          'error="invalid_token"',
          `error_description=${quoteAuthParam(
            auth.description ?? "The access token is invalid or expired",
          )}`,
          `resource_metadata=${quoteAuthParam(protectedResourceMetadataUrl)}`,
        ];

  return `Bearer ${params.join(", ")}`;
};

export const jsonResponse = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: CORS_ALLOW_ORIGIN });

export const jsonRpcError = (status: number, code: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers: CORS_ALLOW_ORIGIN },
  );

export const jsonRpcWebResponse = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { ...CORS_ALLOW_ORIGIN, "content-type": "application/json" },
  });

export const unauthorized = (auth: UnauthorizedAuth, protectedResourceMetadataUrl: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        ...CORS_ALLOW_ORIGIN,
        "www-authenticate": bearerChallenge(auth, protectedResourceMetadataUrl),
      },
    },
  );

export const authTemporarilyUnavailable = (error: McpJwtVerificationError) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      "mcp.auth.outcome": "system_error",
      "mcp.auth.system_error.reason": error.reason,
      "mcp.auth.system_error.message": String(error.cause).slice(0, 500),
    });
    return jsonRpcError(503, -32001, "Authentication temporarily unavailable - please retry");
  });
