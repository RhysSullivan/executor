import { Elysia, t } from "elysia";
import { createAgent } from "@assistant/core";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@executor/database/convex/_generated/api";
import type { Id } from "@executor/database/convex/_generated/dataModel";
import { createFileLinkStore, type LinkedMcpContext } from "./link-store";

interface ServerOptions {
  readonly executorUrl: string;
  readonly convexUrl: string;
  readonly context?: string;
  readonly defaultClientId?: string;
  readonly linksFile?: string;
}

interface ChatIdentity {
  readonly platform: string;
  readonly userId: string;
}

interface ResolvedExecutorContext {
  readonly workspaceId: Id<"workspaces">;
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly clientId?: string;
  readonly mcpAccessToken?: string;
  readonly linked: boolean;
  readonly source: "anonymous" | "linked_anonymous" | "linked_workos";
}

function normalizeIdentityPart(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function identityKey(identity: ChatIdentity): string {
  return `${normalizeIdentityPart(identity.platform)}:${normalizeIdentityPart(identity.userId)}`;
}

function defaultSessionId(identity: ChatIdentity): string {
  const platform = normalizeIdentityPart(identity.platform) || "chat";
  const user = normalizeIdentityPart(identity.userId) || "user";
  return `mcp_assistant_${platform}_${user}`;
}

export function createApp(options: ServerOptions) {
  const convex = new ConvexHttpClient(options.convexUrl);
  const linkStore = createFileLinkStore(options.linksFile);
  const defaultClientId = options.defaultClientId?.trim() || "assistant-chat";

  async function resolveContext(identity: ChatIdentity): Promise<ResolvedExecutorContext> {
    const key = identityKey(identity);
    const linked = await linkStore.get(key);

    if (linked?.provider === "workos" && linked.accessToken) {
      return {
        workspaceId: linked.workspaceId,
        actorId: linked.actorId,
        sessionId: linked.sessionId,
        clientId: linked.clientId ?? defaultClientId,
        mcpAccessToken: linked.accessToken,
        linked: true,
        source: "linked_workos",
      };
    }

    const requestedSessionId = linked?.sessionId ?? defaultSessionId(identity);
    const anonymous = await convex.mutation(api.workspace.bootstrapAnonymousSession, {
      sessionId: requestedSessionId,
    });

    const clientId = linked?.clientId ?? defaultClientId;

    if (linked?.provider === "anonymous") {
      await linkStore.set(key, {
        provider: "anonymous",
        workspaceId: anonymous.workspaceId,
        actorId: anonymous.actorId,
        sessionId: anonymous.sessionId,
        clientId,
        linkedAt: linked.linkedAt,
      });
    }

    return {
      workspaceId: anonymous.workspaceId,
      actorId: anonymous.actorId,
      sessionId: anonymous.sessionId,
      clientId,
      linked: linked?.provider === "anonymous",
      source: linked?.provider === "anonymous" ? "linked_anonymous" : "anonymous",
    };
  }

  function toPublicContext(context: ResolvedExecutorContext) {
    return {
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      sessionId: context.sessionId,
      clientId: context.clientId,
      linked: context.linked,
      source: context.source,
      hasAccessToken: Boolean(context.mcpAccessToken),
    };
  }

  const providerSchema = t.Union([t.Literal("anonymous"), t.Literal("workos")]);

  const app = new Elysia()
    .post(
      "/api/context/resolve",
      async ({ body }) => {
        const context = await resolveContext(body);
        return { context: toPublicContext(context) };
      },
      {
        body: t.Object({
          platform: t.String({ minLength: 1 }),
          userId: t.String({ minLength: 1 }),
        }),
      },
    )

    .post(
      "/api/context/link",
      async ({ body }) => {
        const identity = { platform: body.platform, userId: body.userId } satisfies ChatIdentity;
        const key = identityKey(identity);
        const clientId = body.clientId?.trim() || defaultClientId;
        const linkedAt = Date.now();

        if (body.provider === "workos") {
          if (!body.workspaceId?.trim()) {
            throw new Error("workspaceId is required for workos links");
          }
          if (!body.accessToken?.trim()) {
            throw new Error("accessToken is required for workos links");
          }

          const link: LinkedMcpContext = {
            provider: "workos",
            workspaceId: body.workspaceId as Id<"workspaces">,
            actorId: body.actorId?.trim() || undefined,
            sessionId: body.sessionId?.trim() || undefined,
            accessToken: body.accessToken.trim(),
            clientId,
            linkedAt,
          };
          await linkStore.set(key, link);
          const context = await resolveContext(identity);
          return { linked: true, context: toPublicContext(context) };
        }

        const requestedSessionId = body.sessionId?.trim() || defaultSessionId(identity);
        const anonymous = await convex.mutation(api.workspace.bootstrapAnonymousSession, {
          sessionId: requestedSessionId,
        });

        const link: LinkedMcpContext = {
          provider: "anonymous",
          workspaceId: anonymous.workspaceId,
          actorId: anonymous.actorId,
          sessionId: anonymous.sessionId,
          clientId,
          linkedAt,
        };
        await linkStore.set(key, link);
        const context = await resolveContext(identity);
        return { linked: true, context: toPublicContext(context) };
      },
      {
        body: t.Object({
          platform: t.String({ minLength: 1 }),
          userId: t.String({ minLength: 1 }),
          provider: providerSchema,
          workspaceId: t.Optional(t.String({ minLength: 1 })),
          actorId: t.Optional(t.String({ minLength: 1 })),
          sessionId: t.Optional(t.String({ minLength: 1 })),
          accessToken: t.Optional(t.String({ minLength: 1 })),
          clientId: t.Optional(t.String({ minLength: 1 })),
        }),
      },
    )

    .post(
      "/api/context/unlink",
      async ({ body }) => {
        const removed = await linkStore.delete(identityKey(body));
        return { removed };
      },
      {
        body: t.Object({
          platform: t.String({ minLength: 1 }),
          userId: t.String({ minLength: 1 }),
        }),
      },
    )

    .post(
      "/api/chat/run",
      async ({ body }) => {
        const context = await resolveContext({
          platform: body.platform,
          userId: body.userId,
        });

        const agent = createAgent({
          executorUrl: options.executorUrl,
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          sessionId: context.sessionId,
          clientId: context.clientId,
          mcpAccessToken: context.mcpAccessToken,
          context: options.context,
        });

        const result = await agent.run(body.prompt);
        return {
          text: result.text,
          toolCalls: result.toolCalls,
          context: toPublicContext(context),
        };
      },
      {
        body: t.Object({
          platform: t.String({ minLength: 1 }),
          userId: t.String({ minLength: 1 }),
          prompt: t.String({ minLength: 1 }),
        }),
      },
    );

  return app;
}

export type App = ReturnType<typeof createApp>;
