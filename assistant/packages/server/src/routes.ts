import { Elysia, t } from "elysia";
import {
  createAgent,
  type AgentElicitationRequest,
  type AgentElicitationResponse,
} from "@assistant/core";
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
  readonly accountId?: string;
  readonly sessionId?: string;
  readonly clientId?: string;
  readonly mcpAccessToken?: string;
  readonly mcpApiKey?: string;
  readonly mcpApiKeyError?: string;
  readonly useAnonymousMcp: boolean;
  readonly linked: boolean;
  readonly source: "anonymous" | "linked_anonymous" | "linked_workos";
}

interface PendingElicitation {
  readonly id: string;
  readonly identityKey: string;
  readonly requestId: string;
  readonly mode: "form" | "url";
  readonly message: string;
  readonly requestedSchema?: Record<string, unknown>;
  readonly url?: string;
  readonly elicitationId?: string;
  readonly createdAt: number;
}

interface PendingElicitationEntry extends PendingElicitation {
  readonly resolve: (response: AgentElicitationResponse) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface ResolvePendingElicitationResult {
  readonly ok: boolean;
  readonly error?: string;
}

const ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;

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
  const pendingElicitations = new Map<string, PendingElicitationEntry>();
  const pendingByIdentity = new Map<string, string[]>();

  function removePendingFromQueue(identity: string, id: string) {
    const existing = pendingByIdentity.get(identity);
    if (!existing || existing.length === 0) {
      return;
    }

    const next = existing.filter((candidate) => candidate !== id);
    if (next.length === 0) {
      pendingByIdentity.delete(identity);
      return;
    }
    pendingByIdentity.set(identity, next);
  }

  function nextPending(identity: ChatIdentity, requestId?: string): PendingElicitation | null {
    const key = identityKey(identity);
    const queue = pendingByIdentity.get(key);
    if (!queue || queue.length === 0) {
      return null;
    }

    while (queue.length > 0) {
      const id = queue[0]!;
      const entry = pendingElicitations.get(id);
      if (!entry) {
        queue.shift();
        continue;
      }

      if (requestId && entry.requestId !== requestId) {
        const index = queue.findIndex((candidate) => {
          const candidateEntry = pendingElicitations.get(candidate);
          return Boolean(candidateEntry) && candidateEntry?.requestId === requestId;
        });
        if (index === -1) {
          return null;
        }
        const candidateId = queue[index]!;
        const candidateEntry = pendingElicitations.get(candidateId);
        return candidateEntry ?? null;
      }

      return entry;
    }

    pendingByIdentity.delete(key);
    return null;
  }

  async function waitForElicitationResponse(
    identity: ChatIdentity,
    requestId: string,
    request: AgentElicitationRequest,
  ): Promise<AgentElicitationResponse> {
    const key = identityKey(identity);
    const id = crypto.randomUUID();
    const createdAt = Date.now();

    return await new Promise<AgentElicitationResponse>((resolve) => {
      const resolveAndCleanup = (response: AgentElicitationResponse) => {
        const entry = pendingElicitations.get(id);
        if (!entry) {
          return;
        }
        clearTimeout(entry.timeout);
        pendingElicitations.delete(id);
        removePendingFromQueue(key, id);
        resolve(response);
      };

      const timeout = setTimeout(() => {
        resolveAndCleanup({ action: "cancel" });
      }, ELICITATION_TIMEOUT_MS);

      const entry: PendingElicitationEntry = {
        id,
        identityKey: key,
        requestId,
        mode: request.mode,
        message: request.message,
        requestedSchema: request.requestedSchema,
        url: request.url,
        elicitationId: request.elicitationId,
        createdAt,
        resolve: resolveAndCleanup,
        timeout,
      };

      pendingElicitations.set(id, entry);
      const queue = pendingByIdentity.get(key) ?? [];
      queue.push(id);
      pendingByIdentity.set(key, queue);
    });
  }

  function resolvePendingElicitation(
    identity: ChatIdentity,
    args: {
      requestId?: string;
      elicitationRequestId: string;
      action: AgentElicitationResponse["action"];
      content?: Record<string, unknown>;
    },
  ): ResolvePendingElicitationResult {
    const entry = pendingElicitations.get(args.elicitationRequestId);
    if (!entry) {
      return { ok: false, error: "Elicitation request not found or already resolved." };
    }

    const key = identityKey(identity);
    if (entry.identityKey !== key) {
      return { ok: false, error: "Elicitation request does not belong to this user." };
    }
    if (args.requestId && entry.requestId !== args.requestId) {
      return { ok: false, error: "Elicitation request id does not match the active prompt." };
    }

    if (entry.mode === "url" && args.action === "accept") {
      entry.resolve({ action: "accept" });
      return { ok: true };
    }

    if (entry.mode === "form" && args.action === "accept") {
      if (!args.content) {
        return { ok: false, error: "Form elicitation requires content." };
      }
      entry.resolve({ action: "accept", content: args.content });
      return { ok: true };
    }

    entry.resolve({ action: args.action });
    return { ok: true };
  }

  async function resolveContext(identity: ChatIdentity): Promise<ResolvedExecutorContext> {
    const key = identityKey(identity);
    const linked = await linkStore.get(key);

    if (linked?.provider === "workos" && linked.accessToken) {
      return {
        workspaceId: linked.workspaceId,
        accountId: linked.accountId,
        sessionId: linked.sessionId,
        clientId: linked.clientId ?? defaultClientId,
        mcpAccessToken: linked.accessToken,
        useAnonymousMcp: false,
        linked: true,
        source: "linked_workos",
      };
    }

    if (linked?.provider === "anonymous" && linked.mcpApiKey) {
      return {
        workspaceId: linked.workspaceId,
        accountId: linked.accountId,
        sessionId: linked.sessionId,
        clientId: linked.clientId ?? defaultClientId,
        mcpApiKey: linked.mcpApiKey,
        useAnonymousMcp: true,
        linked: true,
        source: "linked_anonymous",
      };
    }

    const requestedSessionId = linked?.sessionId ?? defaultSessionId(identity);
    const anonymous = await convex.mutation(api.workspace.bootstrapAnonymousSession, {
      sessionId: requestedSessionId,
    });

    const clientId = linked?.clientId ?? defaultClientId;
    const anonymousMcpApiKey = await convex.query(api.workspace.getMcpApiKey, {
      workspaceId: anonymous.workspaceId,
      sessionId: anonymous.sessionId,
    });

    const mcpApiKey = anonymousMcpApiKey?.enabled ? anonymousMcpApiKey.apiKey ?? undefined : undefined;
    const mcpApiKeyError = anonymousMcpApiKey?.enabled
      ? undefined
      : anonymousMcpApiKey?.error ?? "Anonymous MCP API key is unavailable";

    if (linked?.provider === "anonymous") {
      await linkStore.set(key, {
        provider: "anonymous",
        workspaceId: anonymous.workspaceId,
        accountId: anonymous.accountId,
        sessionId: anonymous.sessionId,
        mcpApiKey,
        clientId,
        linkedAt: linked.linkedAt,
      });
    }

    return {
      workspaceId: anonymous.workspaceId,
      accountId: anonymous.accountId,
      sessionId: anonymous.sessionId,
      clientId,
      mcpApiKey,
      mcpApiKeyError,
      useAnonymousMcp: true,
      linked: linked?.provider === "anonymous",
      source: linked?.provider === "anonymous" ? "linked_anonymous" : "anonymous",
    };
  }

  function toPublicContext(context: ResolvedExecutorContext) {
    return {
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      sessionId: context.sessionId,
      clientId: context.clientId,
      linked: context.linked,
      source: context.source,
      hasAccessToken: Boolean(context.mcpAccessToken),
      hasApiKey: Boolean(context.mcpApiKey),
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
            accountId: body.accountId?.trim() || undefined,
            sessionId: body.sessionId?.trim() || undefined,
            accessToken: body.accessToken.trim(),
            clientId,
            linkedAt,
          };
          await linkStore.set(key, link);
          const context = await resolveContext(identity);
          return { linked: true, context: toPublicContext(context) };
        }

        if (!body.workspaceId?.trim()) {
          throw new Error("workspaceId is required for anonymous links");
        }
        if (!body.apiKey?.trim()) {
          throw new Error("apiKey is required for anonymous links");
        }

        const link: LinkedMcpContext = {
          provider: "anonymous",
          workspaceId: body.workspaceId as Id<"workspaces">,
          accountId: body.accountId?.trim() || undefined,
          sessionId: body.sessionId?.trim() || undefined,
          mcpApiKey: body.apiKey.trim(),
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
          accountId: t.Optional(t.String({ minLength: 1 })),
          sessionId: t.Optional(t.String({ minLength: 1 })),
          accessToken: t.Optional(t.String({ minLength: 1 })),
          apiKey: t.Optional(t.String({ minLength: 1 })),
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
      "/api/chat/elicitation/pending",
      async ({ body }) => {
        const identity = {
          platform: body.platform,
          userId: body.userId,
        } satisfies ChatIdentity;

        const pending = nextPending(identity, body.requestId?.trim() || undefined);
        if (!pending) {
          return { elicitation: null };
        }

        return {
          elicitation: {
            id: pending.id,
            requestId: pending.requestId,
            mode: pending.mode,
            message: pending.message,
            requestedSchema: pending.requestedSchema,
            url: pending.url,
            elicitationId: pending.elicitationId,
            createdAt: pending.createdAt,
          },
        };
      },
      {
        body: t.Object({
          platform: t.String({ minLength: 1 }),
          userId: t.String({ minLength: 1 }),
          requestId: t.Optional(t.String({ minLength: 1 })),
        }),
      },
    )

    .post(
      "/api/chat/elicitation/respond",
      async ({ body }) => {
        const identity = {
          platform: body.platform,
          userId: body.userId,
        } satisfies ChatIdentity;

        const resolution = resolvePendingElicitation(identity, {
          requestId: body.requestId?.trim() || undefined,
          elicitationRequestId: body.elicitationRequestId,
          action: body.action,
          content: body.content,
        });

        return resolution;
      },
      {
        body: t.Object({
          platform: t.String({ minLength: 1 }),
          userId: t.String({ minLength: 1 }),
          requestId: t.Optional(t.String({ minLength: 1 })),
          elicitationRequestId: t.String({ minLength: 1 }),
          action: t.Union([t.Literal("accept"), t.Literal("decline"), t.Literal("cancel")]),
          content: t.Optional(t.Record(t.String(), t.Unknown())),
        }),
      },
    )

    .post(
      "/api/chat/run",
      async ({ body }) => {
        const identity = {
          platform: body.platform,
          userId: body.userId,
        } satisfies ChatIdentity;
        const context = await resolveContext({
          platform: identity.platform,
          userId: identity.userId,
        });
        const requestId = body.requestId?.trim() || crypto.randomUUID();

        if (context.useAnonymousMcp && !context.mcpApiKey) {
          throw new Error(context.mcpApiKeyError ?? "Anonymous MCP API key is unavailable");
        }

        const agent = createAgent({
          executorUrl: options.executorUrl,
          workspaceId: context.workspaceId,
          accountId: context.accountId,
          sessionId: context.sessionId,
          clientId: context.clientId,
          mcpAccessToken: context.mcpAccessToken,
          mcpApiKey: context.mcpApiKey,
          useAnonymousMcp: context.useAnonymousMcp,
          context: options.context,
          onElicitation: async (request) => {
            return await waitForElicitationResponse(identity, requestId, request);
          },
        });

        const result = await agent.run(body.prompt);
        return {
          requestId,
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
          requestId: t.Optional(t.String({ minLength: 1 })),
        }),
      },
    );

  return app;
}

export type App = ReturnType<typeof createApp>;
