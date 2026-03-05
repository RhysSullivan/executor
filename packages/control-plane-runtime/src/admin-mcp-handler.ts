import {
  type ControlPlaneInteractionsServiceShape,
  type ResolveInteractionPayload,
} from "@executor-v2/management-api";
import { handleMcpHttpRequest } from "@executor-v2/mcp-gateway";
import type { InteractionId, TaskRunId, WorkspaceId } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

export type RuntimeHostAdminMcpHandlerOptions = {
  interactions: ControlPlaneInteractionsServiceShape;
};

const listInteractionsInputSchema = {} as any;
const getInteractionInputSchema = {} as any;
const resolveInteractionInputSchema = {} as any;

const toText = (value: unknown): string => JSON.stringify(value, null, 2);

const readRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const readRequiredString = (value: unknown, field: string): string => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`Missing required field: ${field}`);
};

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const readOptionalNullableString = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }

  return readOptionalString(value);
};

const readAction = (value: unknown): "accept" | "decline" | "cancel" => {
  if (value === "accept" || value === "decline" || value === "cancel") {
    return value;
  }

  throw new Error("Invalid action. Expected one of: accept, decline, cancel");
};

const toolError = (cause: unknown) => ({
  content: [{ type: "text" as const, text: cause instanceof Error ? cause.message : String(cause) }],
  isError: true,
});

const toolSuccess = (value: unknown) => ({
  content: [{ type: "text" as const, text: toText(value) }],
  isError: false,
});

export const createRuntimeHostAdminMcpHandler = (
  options: RuntimeHostAdminMcpHandlerOptions,
): ((request: Request) => Promise<Response>) =>
  async (request: Request) =>
    handleMcpHttpRequest(request, {
      serverName: "executor-v2-admin-host",
      serverVersion: "0.0.0",
      registerTools: (server) => {
        server.registerTool(
          "interactions.list",
          {
            description: "List interactions by workspace or run",
            inputSchema: listInteractionsInputSchema,
          },
          async (input: unknown) => {
            try {
              const record = readRecord(input);
              if (!record) {
                throw new Error("Invalid input payload");
              }

              const workspaceId = readRequiredString(record.workspaceId, "workspaceId") as WorkspaceId;
              const runId = readOptionalString(record.runId);

              const interactions = runId
                ? await Effect.runPromise(options.interactions.listRunInteractions({
                    workspaceId,
                    runId: runId as TaskRunId,
                  }))
                : await Effect.runPromise(options.interactions.listInteractions(workspaceId));

              return toolSuccess(interactions);
            } catch (cause) {
              return toolError(cause);
            }
          },
        );

        server.registerTool(
          "interactions.get",
          {
            description: "Get interaction details",
            inputSchema: getInteractionInputSchema,
          },
          async (input: unknown) => {
            try {
              const record = readRecord(input);
              if (!record) {
                throw new Error("Invalid input payload");
              }

              const interaction = await Effect.runPromise(options.interactions.getInteraction({
                workspaceId: readRequiredString(record.workspaceId, "workspaceId") as WorkspaceId,
                interactionId: readRequiredString(record.interactionId, "interactionId") as InteractionId,
              }));

              return toolSuccess(interaction);
            } catch (cause) {
              return toolError(cause);
            }
          },
        );

        server.registerTool(
          "interactions.resolve",
          {
            description: "Resolve interaction by action",
            inputSchema: resolveInteractionInputSchema,
          },
          async (input: unknown) => {
            try {
              const record = readRecord(input);
              if (!record) {
                throw new Error("Invalid input payload");
              }

              const payload: ResolveInteractionPayload = {
                action: readAction(record.action),
                reason: readOptionalNullableString(record.reason),
                contentJson: readOptionalNullableString(record.contentJson),
              };

              const interaction = await Effect.runPromise(options.interactions.resolveInteraction({
                workspaceId: readRequiredString(record.workspaceId, "workspaceId") as WorkspaceId,
                interactionId: readRequiredString(record.interactionId, "interactionId") as InteractionId,
                payload,
              }));

              return toolSuccess(interaction);
            } catch (cause) {
              return toolError(cause);
            }
          },
        );
      },
    });
