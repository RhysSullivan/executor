import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { handleMcpRequest, type McpWorkspaceContext } from "../../../core/src/mcp-server";
import { isAnonymousIdentity } from "../../src/auth/anonymous";
import { getAnonymousAuthIssuer } from "../../src/auth/anonymous";
import {
  getMcpAuthConfig,
  isAnonymousSessionId,
  parseMcpContext,
  unauthorizedMcpResponse,
  verifyMcpToken,
} from "./mcp_auth";
import { createMcpExecutorService } from "./mcp_service";

type McpEndpointMode = "default" | "anonymous";

function isAnonymousAuthConfigured(): boolean {
  const issuer = getAnonymousAuthIssuer();
  const privateKeyPem = process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM;
  return Boolean(issuer && privateKeyPem && privateKeyPem.trim().length > 0);
}

function createMcpHandler(mode: McpEndpointMode) {
  return httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const mcpAuthConfig = getMcpAuthConfig();
    const requestedContext = parseMcpContext(url);

    const hasAnonymousContextHint = isAnonymousSessionId(requestedContext?.sessionId)
      || requestedContext?.actorId?.startsWith("anon_")
      || false;

    if (mode === "default" && hasAnonymousContextHint) {
      return Response.json(
        { error: "Anonymous context must use /mcp/anonymous" },
        { status: 400 },
      );
    }

    let context: McpWorkspaceContext | undefined;

      if (mode === "anonymous") {
        try {
          const workspaceId = requestedContext?.workspaceId;
          if (!workspaceId) {
          return Response.json(
            { error: "workspaceId query parameter is required for /mcp/anonymous" },
            { status: 400 },
          );
          }

          const anonymousAuthConfigured = isAnonymousAuthConfigured();
          if (anonymousAuthConfigured && (requestedContext?.sessionId || requestedContext?.actorId)) {
            return Response.json(
              {
                error:
                  "Legacy anonymous context query params are disabled. Use Authorization: Bearer <anonymous token>.",
              },
              { status: 400 },
            );
          }

          const identity = await ctx.auth.getUserIdentity().catch(() => null);
          if (identity && isAnonymousIdentity(identity)) {
            const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForAnonymousSubject, {
              workspaceId,
              actorId: identity.subject,
            });

            context = {
              workspaceId,
              actorId: access.actorId,
              clientId: requestedContext?.clientId,
            };
          } else if (!anonymousAuthConfigured && requestedContext?.actorId) {
            // Local/test fallback: allow query-param actorId when anonymous auth isn't configured.
            const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForAnonymousSubject, {
              workspaceId,
              actorId: requestedContext.actorId,
            });

            context = {
              workspaceId,
              actorId: access.actorId,
              clientId: requestedContext?.clientId,
            };
          } else {
            return Response.json(
              { error: "Anonymous bearer token is required for /mcp/anonymous" },
              { status: 401 },
            );
          }
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Workspace authorization failed" },
            { status: 403 },
        );
      }
    } else {
      const auth = await verifyMcpToken(ctx, request, mcpAuthConfig);
      if (mcpAuthConfig.enabled && !auth) {
        return unauthorizedMcpResponse(request, "No valid bearer token provided.");
      }

      if (mcpAuthConfig.enabled && auth?.provider === "workos" && !requestedContext?.workspaceId) {
        return Response.json(
          { error: "workspaceId query parameter is required when MCP OAuth is enabled" },
          { status: 400 },
        );
      }

      const hasRequestedWorkspace = Boolean(requestedContext?.workspaceId);
      if (hasRequestedWorkspace) {
        try {
          const workspaceId = requestedContext?.workspaceId;
          if (!workspaceId) {
            return Response.json(
              { error: "workspaceId query parameter is required" },
              { status: 400 },
            );
          }

          if (auth?.provider === "workos") {
            const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForWorkosSubject, {
              workspaceId,
              subject: auth.subject,
            });

            context = {
              workspaceId,
              actorId: access.actorId,
              clientId: requestedContext?.clientId,
            };
          } else {
            if (mcpAuthConfig.enabled && !requestedContext?.sessionId) {
              return unauthorizedMcpResponse(request, "No valid bearer token provided.");
            }

            const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
              workspaceId,
              sessionId: requestedContext?.sessionId,
            });

            if (mcpAuthConfig.enabled && access.provider !== "anonymous") {
              return unauthorizedMcpResponse(
                request,
                "Bearer token required for non-anonymous sessions.",
              );
            }

            context = {
              workspaceId,
              actorId: access.actorId,
              clientId: requestedContext?.clientId,
              sessionId: requestedContext?.sessionId,
            };
          }
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Workspace authorization failed" },
            { status: 403 },
          );
        }
      }
    }

    const service = createMcpExecutorService(ctx);
    return await handleMcpRequest(service, request, context);
  });
}

export const mcpHandler = createMcpHandler("default");
export const mcpAnonymousHandler = createMcpHandler("anonymous");
