import type { ControlPlaneClient } from "@executor-v3/control-plane";
import * as Effect from "effect/Effect";

export type SeedDemoMcpSourceInput = {
  client: ControlPlaneClient;
  workspaceId: string;
  endpoint: string;
  name: string;
  namespace: string;
};

export type SeedDemoMcpSourceResult =
  | {
      action: "noop";
      sourceId: string;
      workspaceId: string;
      endpoint: string;
    }
  | {
      action: "updated" | "created";
      sourceId: string;
      workspaceId: string;
      endpoint: string;
    };

export const seedDemoMcpSourceInWorkspace = (
  input: SeedDemoMcpSourceInput,
): Effect.Effect<SeedDemoMcpSourceResult, unknown, never> =>
  Effect.gen(function* () {
    const existing = yield* input.client.sources.list({
      path: {
        workspaceId: input.workspaceId as never,
      },
    });

    const existingByName = existing.find(
      (source) => source.kind === "mcp" && source.name === input.name,
    );

    if (
      existingByName !== undefined
      && existingByName.endpoint === input.endpoint
      && existingByName.configJson
        === JSON.stringify({
          namespace: input.namespace,
          transport: "streamable-http",
        })
    ) {
      return {
        action: "noop",
        sourceId: existingByName.id,
        workspaceId: input.workspaceId,
        endpoint: existingByName.endpoint,
      };
    }

    if (existingByName !== undefined) {
      const updated = yield* input.client.sources.update({
        path: {
          workspaceId: input.workspaceId as never,
          sourceId: existingByName.id,
        },
        payload: {
          endpoint: input.endpoint,
          status: "connected",
          enabled: true,
          configJson: JSON.stringify({
            namespace: input.namespace,
            transport: "streamable-http",
          }),
        },
      });

      return {
        action: "updated",
        sourceId: updated.id,
        workspaceId: input.workspaceId,
        endpoint: updated.endpoint,
      };
    }

    const created = yield* input.client.sources.create({
      path: {
        workspaceId: input.workspaceId as never,
      },
      payload: {
        name: input.name,
        kind: "mcp",
        endpoint: input.endpoint,
        status: "connected",
        enabled: true,
        configJson: JSON.stringify({
          namespace: input.namespace,
          transport: "streamable-http",
        }),
      },
    });

    return {
      action: "created",
      sourceId: created.id,
      workspaceId: input.workspaceId,
      endpoint: created.endpoint,
    };
  });
