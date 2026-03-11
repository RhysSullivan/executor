import {
  type ControlPlaneClient,
  WorkspaceIdSchema,
} from "@executor/control-plane";
import * as Effect from "effect/Effect";

const readBindingString = (binding: Record<string, unknown>, key: string): string | null =>
  typeof binding[key] === "string" ? String(binding[key]) : null;

type SeedDemoMcpSourceInput = {
  client: ControlPlaneClient;
  workspaceId: string;
  endpoint: string;
  name: string;
  namespace: string;
};

type SeedDemoMcpSourceResult =
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

type SeedGithubOpenApiSourceInput = {
  client: ControlPlaneClient;
  workspaceId: string;
  endpoint: string;
  specUrl: string;
  name: string;
  namespace: string;
  credentialEnvVar?: string;
};

export const seedDemoMcpSourceInWorkspace = (
  input: SeedDemoMcpSourceInput,
): Effect.Effect<SeedDemoMcpSourceResult, unknown, never> =>
  Effect.gen(function* () {
    const workspaceId = WorkspaceIdSchema.make(input.workspaceId);

    const existing = yield* input.client.sources.list({
      path: {
        workspaceId,
      },
    });

    const existingByName = existing.find(
      (source) => source.kind === "mcp" && source.name === input.name,
    );

    const expected = {
      endpoint: input.endpoint,
      namespace: input.namespace,
      transport: "streamable-http" as const,
    };

    if (
      existingByName !== undefined
      && existingByName.endpoint === expected.endpoint
      && existingByName.namespace === expected.namespace
      && readBindingString(existingByName.binding, "transport") === expected.transport
      && existingByName.auth.kind === "none"
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
          workspaceId,
          sourceId: existingByName.id,
        },
        payload: {
          endpoint: input.endpoint,
          status: "connected",
          enabled: true,
          namespace: input.namespace,
          binding: {
            transport: "streamable-http",
            queryParams: null,
            headers: null,
          },
          auth: {
            kind: "none",
          },
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
        workspaceId,
      },
      payload: {
        name: input.name,
        kind: "mcp",
        endpoint: input.endpoint,
        status: "connected",
        enabled: true,
        namespace: input.namespace,
        binding: {
          transport: "streamable-http",
          queryParams: null,
          headers: null,
        },
        auth: {
          kind: "none",
        },
      },
    });

    return {
      action: "created",
      sourceId: created.id,
      workspaceId: input.workspaceId,
      endpoint: created.endpoint,
    };
  });

export const seedGithubOpenApiSourceInWorkspace = (
  input: SeedGithubOpenApiSourceInput,
): Effect.Effect<SeedDemoMcpSourceResult, unknown, never> =>
  Effect.gen(function* () {
    const workspaceId = WorkspaceIdSchema.make(input.workspaceId);

    const existing = yield* input.client.sources.list({
      path: {
        workspaceId,
      },
    });

    const existingByName = existing.find(
      (source) => source.kind === "openapi" && source.name === input.name,
    );

    const auth = {
      kind: "bearer" as const,
      headerName: "Authorization",
      prefix: "Bearer ",
      token: {
        providerId: "env",
        handle: input.credentialEnvVar ?? "GITHUB_TOKEN",
      },
    };

    if (
      existingByName !== undefined
      && existingByName.endpoint === input.endpoint
      && existingByName.namespace === input.namespace
      && readBindingString(existingByName.binding, "specUrl") === input.specUrl
      && JSON.stringify(existingByName.binding.defaultHeaders ?? null) === JSON.stringify(null)
      && JSON.stringify(existingByName.auth) === JSON.stringify(auth)
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
          workspaceId,
          sourceId: existingByName.id,
        },
        payload: {
          endpoint: input.endpoint,
          status: "connected",
          enabled: true,
          namespace: input.namespace,
          binding: {
            specUrl: input.specUrl,
            defaultHeaders: null,
          },
          auth,
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
        workspaceId,
      },
      payload: {
        name: input.name,
        kind: "openapi",
        endpoint: input.endpoint,
        status: "connected",
        enabled: true,
        namespace: input.namespace,
        binding: {
          specUrl: input.specUrl,
          defaultHeaders: null,
        },
        auth,
      },
    });

    return {
      action: "created",
      sourceId: created.id,
      workspaceId: input.workspaceId,
      endpoint: created.endpoint,
    };
  });
