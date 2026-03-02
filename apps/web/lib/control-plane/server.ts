import {
  ControlPlaneAuthHeaders,
  ControlPlaneService,
  fetchOpenApiDocument,
  makeControlPlaneService,
  makeControlPlaneSourcesService,
  makeControlPlaneWebHandler,
  makeSourceCatalogService,
  makeSourceManagerService,
} from "@executor-v2/management-api";
import {
  makeSqlControlPlanePersistence,
  type SqlControlPlanePersistence,
} from "@executor-v2/persistence-sql";
import {
  type SourceStore,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import {
  type Profile,
  type Organization,
  type OrganizationMembership,
  type Workspace,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PmActorLive } from "../../../pm/src/actor";
import { createPmApprovalsService } from "../../../pm/src/approvals-service";
import { createPmCredentialsService } from "../../../pm/src/credentials-service";
import { createPmOrganizationsService } from "../../../pm/src/organizations-service";
import { createPmPoliciesService } from "../../../pm/src/policies-service";
import { createPmStorageService } from "../../../pm/src/storage-service";
import { createPmToolsService } from "../../../pm/src/tools-service";
import { createPmWorkspacesService } from "../../../pm/src/workspaces-service";

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const defaultControlPlaneStateRootDir = ".executor-v2/web-state";
const defaultControlPlaneSqliteFile = `${defaultControlPlaneStateRootDir}/control-plane.sqlite`;

type ControlPlaneRuntime = {
  persistence: SqlControlPlanePersistence;
  sourceStore: SourceStore;
  toolArtifactStore: ToolArtifactStore;
  fetchOpenApiDocument: typeof fetchOpenApiDocument;
  handleControlPlane: (request: Request) => Promise<Response>;
  dispose: () => Promise<void>;
};

type ControlPlanePrincipal = {
  accountId: string;
  provider: "local" | "workos" | "service";
  subject: string;
  email: string | null;
  displayName: string | null;
  organizationId: string;
  workspaceId: string;
};

const normalizeIdPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");

const toAccountScopedIds = (subject: string) => {
  const normalized = normalizeIdPart(subject);

  return {
    accountId: `acct_${normalized}`,
    organizationId: `org_${normalized}`,
    workspaceId: `ws_${normalized}`,
  };
};

const resolveDatabaseUrl = (): string | undefined => {
  const candidates = [
    process.env.CONTROL_PLANE_DATABASE_URL,
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
  ];

  for (const candidate of candidates) {
    const value = trim(candidate);
    if (value) {
      return value;
    }
  }

  return undefined;
};

const resolveSqlitePath = (): string =>
  trim(process.env.CONTROL_PLANE_SQLITE_PATH) ?? defaultControlPlaneSqliteFile;

const resolveStateRootDir = (): string =>
  trim(process.env.CONTROL_PLANE_STATE_ROOT_DIR) ?? defaultControlPlaneStateRootDir;

const ensurePrincipalProvisioned = (
  persistence: SqlControlPlanePersistence,
  principal: ControlPlanePrincipal,
) =>
  Effect.gen(function* () {
    const now = Date.now();
    const [organizations, memberships, workspaces, profileOption] = yield* Effect.all([
      persistence.rows.organizations.list(),
      persistence.rows.organizationMemberships.list(),
      persistence.rows.workspaces.list(),
      persistence.rows.profile.get(),
    ]);

    if (organizations.find((organization) => organization.id === principal.organizationId) === undefined) {
      yield* persistence.rows.organizations.upsert({
        id: principal.organizationId as Organization["id"],
        slug: principal.organizationId,
        name: principal.displayName
          ? `${principal.displayName}'s Organization`
          : principal.organizationId,
        status: "active",
        createdByAccountId: principal.accountId as Organization["createdByAccountId"],
        createdAt: now,
        updatedAt: now,
      });
    }

    if (
      memberships.find(
        (membership) =>
          membership.organizationId === principal.organizationId
          && membership.accountId === principal.accountId,
      ) === undefined
    ) {
      yield* persistence.rows.organizationMemberships.upsert({
        id: `org_member_${crypto.randomUUID()}` as OrganizationMembership["id"],
        organizationId: principal.organizationId as OrganizationMembership["organizationId"],
        accountId: principal.accountId as OrganizationMembership["accountId"],
        role: "owner",
        status: "active",
        billable: false,
        invitedByAccountId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (workspaces.find((workspace) => workspace.id === principal.workspaceId) === undefined) {
      yield* persistence.rows.workspaces.upsert({
        id: principal.workspaceId as Workspace["id"],
        organizationId: principal.organizationId as Workspace["organizationId"],
        name: principal.displayName
          ? `${principal.displayName}'s Workspace`
          : principal.workspaceId,
        createdByAccountId: principal.accountId as Workspace["createdByAccountId"],
        createdAt: now,
        updatedAt: now,
      });
    }

    const existingProfile = profileOption._tag === "Some" ? profileOption.value : null;

    if (
      existingProfile === null
      || existingProfile.defaultWorkspaceId !== principal.workspaceId
      || existingProfile.displayName !== (principal.displayName ?? existingProfile.displayName)
    ) {
      yield* persistence.rows.profile.upsert({
        id: existingProfile?.id ?? ("profile_local" as Profile["id"]),
        defaultWorkspaceId: principal.workspaceId as Profile["defaultWorkspaceId"],
        displayName: principal.displayName ?? existingProfile?.displayName ?? "Local",
        runtimeMode: existingProfile?.runtimeMode ?? "local",
        createdAt: existingProfile?.createdAt ?? now,
        updatedAt: now,
      });
    }
  });

let runtimePromise: Promise<ControlPlaneRuntime> | undefined;

const createControlPlaneRuntime = async (): Promise<ControlPlaneRuntime> => {
  const stateRootDir = resolveStateRootDir();

  const persistence = await Effect.runPromise(
    makeSqlControlPlanePersistence({
      databaseUrl: resolveDatabaseUrl(),
      sqlitePath: resolveSqlitePath(),
      postgresApplicationName: "executor-v2-web",
    }),
  );

  const sourceStore = persistence.sourceStore;
  const toolArtifactStore = persistence.toolArtifactStore;

  const sourceCatalog = makeSourceCatalogService(sourceStore);
  const sourceManager = makeSourceManagerService(toolArtifactStore);
  const baseSourcesService = makeControlPlaneSourcesService(sourceCatalog);

  const sourcesService = {
    ...baseSourcesService,
    upsertSource: (input: Parameters<typeof baseSourcesService.upsertSource>[0]) =>
      Effect.gen(function* () {
        const source = yield* baseSourcesService.upsertSource(input);

        if (source.kind !== "openapi") {
          return source;
        }

        const openApiSpecResult = yield* Effect.tryPromise({
          try: () => fetchOpenApiDocument(source.endpoint),
          catch: (cause) => String(cause),
        }).pipe(Effect.either);

        if (openApiSpecResult._tag === "Left") {
          return source;
        }

        yield* sourceManager
          .refreshOpenApiArtifact({
            source,
            openApiSpec: openApiSpecResult.right,
          })
          .pipe(Effect.ignore);

        return source;
      }),
  };

  const controlPlaneService = makeControlPlaneService({
    sources: sourcesService,
    credentials: createPmCredentialsService(persistence.rows),
    policies: createPmPoliciesService(persistence.rows),
    organizations: createPmOrganizationsService(persistence.rows),
    workspaces: createPmWorkspacesService(persistence.rows),
    tools: createPmToolsService(sourceStore, toolArtifactStore),
    storage: createPmStorageService(persistence.rows, {
      stateRootDir,
    }),
    approvals: createPmApprovalsService(persistence.rows),
  });

  const controlPlaneWebHandler = makeControlPlaneWebHandler(
    Layer.succeed(ControlPlaneService, controlPlaneService),
    PmActorLive(persistence.rows),
  );

  return {
    persistence,
    sourceStore,
    toolArtifactStore,
    fetchOpenApiDocument,
    handleControlPlane: controlPlaneWebHandler.handler,
    dispose: async () => {
      await controlPlaneWebHandler.dispose();
      await persistence.close();
    },
  };
};

export const getControlPlaneRuntime = async (): Promise<ControlPlaneRuntime> => {
  if (!runtimePromise) {
    runtimePromise = createControlPlaneRuntime();
  }

  return runtimePromise;
};

export const createWorkosPrincipal = (input: {
  subject: string;
  email: string | null;
  displayName: string | null;
}): ControlPlanePrincipal => {
  const ids = toAccountScopedIds(input.subject);

  return {
    accountId: ids.accountId,
    provider: "workos",
    subject: input.subject,
    email: input.email,
    displayName: input.displayName,
    organizationId: ids.organizationId,
    workspaceId: ids.workspaceId,
  };
};

export const createLocalPrincipal = (): ControlPlanePrincipal => ({
  accountId: "acct_demo",
  provider: "local",
  subject: "local:demo",
  email: null,
  displayName: "Local Demo",
  organizationId: "org_demo",
  workspaceId: "ws_demo",
});

export const applyPrincipalHeaders = (
  request: Request,
  principal: ControlPlanePrincipal,
): Request => {
  const headers = new Headers(request.headers);

  headers.set(ControlPlaneAuthHeaders.accountId, principal.accountId);
  headers.set(ControlPlaneAuthHeaders.principalProvider, principal.provider);
  headers.set(ControlPlaneAuthHeaders.principalSubject, principal.subject);

  if (principal.email) {
    headers.set(ControlPlaneAuthHeaders.principalEmail, principal.email);
  }

  if (principal.displayName) {
    headers.set(ControlPlaneAuthHeaders.principalDisplayName, principal.displayName);
  }

  return new Request(request, { headers });
};

export const provisionPrincipal = async (
  runtime: ControlPlaneRuntime,
  principal: ControlPlanePrincipal,
): Promise<void> => {
  await Effect.runPromise(ensurePrincipalProvisioned(runtime.persistence, principal));
};
