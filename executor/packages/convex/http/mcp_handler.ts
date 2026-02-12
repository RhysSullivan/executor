import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { handleMcpRequest, type McpWorkspaceContext } from "../../core/src/mcp-server";
import {
  getMcpAuthConfig,
  parseMcpContext,
  unauthorizedMcpResponse,
  verifyMcpToken,
} from "./mcp_auth";
import { createMcpExecutorService } from "./mcp_service";

export const mcpHandler = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const mcpAuthConfig = getMcpAuthConfig();
  const auth = await verifyMcpToken(ctx, request, mcpAuthConfig);
  const requestedContext = parseMcpContext(url);

  if (mcpAuthConfig.enabled && !auth) {
    return unauthorizedMcpResponse(request, "No valid bearer token provided.");
  }

  if (mcpAuthConfig.enabled && auth?.provider === "workos" && !requestedContext?.workspaceId) {
    return Response.json(
      { error: "workspaceId query parameter is required when MCP OAuth is enabled" },
      { status: 400 },
    );
  }

  let context: McpWorkspaceContext | undefined;
  const hasRequestedWorkspace = Boolean(requestedContext?.workspaceId);
  const hasAnonymousTokenContext = auth?.provider === "anonymous" && Boolean(auth.workspaceId || auth.sessionId);

  if (hasRequestedWorkspace || hasAnonymousTokenContext) {
    try {
      if (auth?.provider === "workos") {
        const workspaceId = requestedContext?.workspaceId;
        if (!workspaceId) {
          return Response.json(
            { error: "workspaceId query parameter is required when MCP OAuth is enabled" },
            { status: 400 },
          );
        }

        const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForWorkosSubject, {
          workspaceId,
          subject: auth.subject,
        });

        context = {
          workspaceId,
          actorId: access.actorId,
          clientId: requestedContext?.clientId,
        };
      } else if (auth?.provider === "anonymous") {
        const workspaceId = requestedContext?.workspaceId ?? auth.workspaceId;
        const sessionId = requestedContext?.sessionId ?? auth.sessionId;

        if (!workspaceId || !sessionId) {
          return unauthorizedMcpResponse(
            request,
            "Anonymous OAuth token must include workspace and session context.",
          );
        }

        if (requestedContext?.workspaceId && auth.workspaceId && requestedContext.workspaceId !== auth.workspaceId) {
          return unauthorizedMcpResponse(request, "Anonymous token workspace does not match requested workspace.");
        }
        if (requestedContext?.sessionId && auth.sessionId && requestedContext.sessionId !== auth.sessionId) {
          return unauthorizedMcpResponse(request, "Anonymous token session does not match requested session.");
        }

        const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
          workspaceId,
          sessionId,
        });

        if (access.provider !== "anonymous") {
          return unauthorizedMcpResponse(request, "Anonymous OAuth token requires an anonymous session.");
        }
        if (access.actorId !== auth.subject) {
          return unauthorizedMcpResponse(request, "Anonymous token subject does not match session actor.");
        }

        context = {
          workspaceId,
          actorId: access.actorId,
          clientId: requestedContext?.clientId,
          sessionId,
        };
      } else {
        const workspaceId = requestedContext?.workspaceId;
        if (!workspaceId) {
          return Response.json(
            { error: "workspaceId query parameter is required when MCP OAuth is enabled" },
            { status: 400 },
          );
        }

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

  const service = createMcpExecutorService(ctx);
  return await handleMcpRequest(service, request, context);
});
