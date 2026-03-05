import {
  type Interaction,
  type AuthConnection,
  type AuthMaterial,
  type OAuthState,
  type Organization,
  type OrganizationMembership,
  type Policy,
  type Profile,
  type SecretMaterial,
  type SourceAuthBinding,
  type StorageInstance,
  type Workspace,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";

import { toRowStoreError } from "./persistence-errors";
import { tableNames } from "./schema";
import {
  type DrizzleDb,
  type DrizzleTables,
  type SqlBackend,
} from "./sql-internals";

type CreateControlPlaneRowsInput = {
  backend: SqlBackend;
  db: DrizzleDb;
  tables: DrizzleTables;
};

const asDomain = <A>(value: unknown): A => value as A;
const asDomainArray = <A>(value: ReadonlyArray<unknown>): Array<A> => value as Array<A>;
const withoutCreatedAt = <A extends { createdAt: unknown }>(value: A): Omit<A, "createdAt"> => {
  const { createdAt: _createdAt, ...rest } = value;
  return rest;
};

const rowEffect = <A>(
  backend: SqlBackend,
  operation: string,
  location: string,
  run: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => toRowStoreError(backend, operation, location, cause),
  });

export const createControlPlaneRows = ({
  backend,
  db,
  tables,
}: CreateControlPlaneRowsInput) => ({
  profile: {
    get: () =>
      rowEffect(backend, "rows.profile.get", tableNames.profile, async () => {
        const row = await db
          .select()
          .from(tables.profileTable)
          .orderBy(desc(tables.profileTable.updatedAt), asc(tables.profileTable.id))
          .limit(1);

        return row[0] ? Option.some(asDomain<Profile>(row[0])) : Option.none<Profile>();
      }),

    upsert: (profile: Profile) =>
      rowEffect(backend, "rows.profile.upsert", tableNames.profile, async () => {
        await db
          .insert(tables.profileTable)
          .values(profile)
          .onConflictDoUpdate({
            target: tables.profileTable.id,
            set: withoutCreatedAt(profile),
          });
      }),
  },

  organizations: {
    list: () =>
      rowEffect(backend, "rows.organizations.list", tableNames.organizations, async () => {
        const rows = await db
          .select()
          .from(tables.organizationsTable)
          .orderBy(asc(tables.organizationsTable.updatedAt), asc(tables.organizationsTable.id));

        return asDomainArray<Organization>(rows);
      }),

    getById: (organizationId: Organization["id"]) =>
      rowEffect(backend, "rows.organizations.get_by_id", tableNames.organizations, async () => {
        const row = await db
          .select()
          .from(tables.organizationsTable)
          .where(eq(tables.organizationsTable.id, organizationId))
          .limit(1);

        return row[0]
          ? Option.some(asDomain<Organization>(row[0]))
          : Option.none<Organization>();
      }),

    getBySlug: (slug: Organization["slug"]) =>
      rowEffect(
        backend,
        "rows.organizations.get_by_slug",
        tableNames.organizations,
        async () => {
          const row = await db
            .select()
            .from(tables.organizationsTable)
            .where(eq(tables.organizationsTable.slug, slug))
            .limit(1);

          return row[0]
            ? Option.some(asDomain<Organization>(row[0]))
            : Option.none<Organization>();
        },
      ),

    upsert: (organization: Organization) =>
      rowEffect(backend, "rows.organizations.upsert", tableNames.organizations, async () => {
        await db
          .insert(tables.organizationsTable)
          .values(organization)
          .onConflictDoUpdate({
            target: tables.organizationsTable.id,
            set: withoutCreatedAt(organization),
          });
      }),
  },

  organizationMemberships: {
    list: () =>
      rowEffect(
        backend,
        "rows.organization_memberships.list",
        tableNames.organizationMemberships,
        async () => {
          const rows = await db
            .select()
            .from(tables.organizationMembershipsTable)
            .orderBy(
              asc(tables.organizationMembershipsTable.updatedAt),
              asc(tables.organizationMembershipsTable.id),
            );

          return asDomainArray<OrganizationMembership>(rows);
        },
      ),

    listByOrganizationId: (organizationId: OrganizationMembership["organizationId"]) =>
      rowEffect(
        backend,
        "rows.organization_memberships.list_by_organization",
        tableNames.organizationMemberships,
        async () => {
          const rows = await db
            .select()
            .from(tables.organizationMembershipsTable)
            .where(eq(tables.organizationMembershipsTable.organizationId, organizationId))
            .orderBy(
              asc(tables.organizationMembershipsTable.updatedAt),
              asc(tables.organizationMembershipsTable.id),
            );

          return asDomainArray<OrganizationMembership>(rows);
        },
      ),

    listByAccountId: (accountId: OrganizationMembership["accountId"]) =>
      rowEffect(
        backend,
        "rows.organization_memberships.list_by_account",
        tableNames.organizationMemberships,
        async () => {
          const rows = await db
            .select()
            .from(tables.organizationMembershipsTable)
            .where(eq(tables.organizationMembershipsTable.accountId, accountId))
            .orderBy(
              asc(tables.organizationMembershipsTable.updatedAt),
              asc(tables.organizationMembershipsTable.id),
            );

          return asDomainArray<OrganizationMembership>(rows);
        },
      ),

    getByOrganizationAndAccount: (
      organizationId: OrganizationMembership["organizationId"],
      accountId: OrganizationMembership["accountId"],
    ) =>
      rowEffect(
        backend,
        "rows.organization_memberships.get_by_organization_and_account",
        tableNames.organizationMemberships,
        async () => {
          const row = await db
            .select()
            .from(tables.organizationMembershipsTable)
            .where(
              and(
                eq(tables.organizationMembershipsTable.organizationId, organizationId),
                eq(tables.organizationMembershipsTable.accountId, accountId),
              ),
            )
            .limit(1);

          return row[0]
            ? Option.some(asDomain<OrganizationMembership>(row[0]))
            : Option.none<OrganizationMembership>();
        },
      ),

    upsert: (membership: OrganizationMembership) =>
      rowEffect(
        backend,
        "rows.organization_memberships.upsert",
        tableNames.organizationMemberships,
        async () => {
          await db
            .insert(tables.organizationMembershipsTable)
            .values(membership)
            .onConflictDoUpdate({
              target: tables.organizationMembershipsTable.id,
              set: withoutCreatedAt(membership),
            });
        },
      ),
  },

  workspaces: {
    list: () =>
      rowEffect(backend, "rows.workspaces.list", tableNames.workspaces, async () => {
        const rows = await db
          .select()
          .from(tables.workspacesTable)
          .orderBy(asc(tables.workspacesTable.updatedAt), asc(tables.workspacesTable.id));

        return asDomainArray<Workspace>(rows);
      }),

    getById: (workspaceId: Workspace["id"]) =>
      rowEffect(backend, "rows.workspaces.get_by_id", tableNames.workspaces, async () => {
        const row = await db
          .select()
          .from(tables.workspacesTable)
          .where(eq(tables.workspacesTable.id, workspaceId))
          .limit(1);

        return row[0] ? Option.some(asDomain<Workspace>(row[0])) : Option.none<Workspace>();
      }),

    listByOrganizationIds: (
      organizationIds: ReadonlyArray<Workspace["organizationId"]>,
    ) =>
      rowEffect(
        backend,
        "rows.workspaces.list_by_organization_ids",
        tableNames.workspaces,
        async () => {
          if (organizationIds.length === 0) {
            return [] as Array<Workspace>;
          }

          const rows = await db
            .select()
            .from(tables.workspacesTable)
            .where(inArray(tables.workspacesTable.organizationId, [...organizationIds]))
            .orderBy(asc(tables.workspacesTable.updatedAt), asc(tables.workspacesTable.id));

          return asDomainArray<Workspace>(rows);
        },
      ),

    upsert: (workspace: Workspace) =>
      rowEffect(backend, "rows.workspaces.upsert", tableNames.workspaces, async () => {
        await db
          .insert(tables.workspacesTable)
          .values(workspace)
          .onConflictDoUpdate({
            target: tables.workspacesTable.id,
            set: withoutCreatedAt(workspace),
          });
      }),
  },

  authConnections: {
    list: () =>
      rowEffect(
        backend,
        "rows.auth_connections.list",
        tableNames.authConnections,
        async () => {
          const rows = await db
            .select()
            .from(tables.authConnectionsTable)
            .orderBy(asc(tables.authConnectionsTable.updatedAt), asc(tables.authConnectionsTable.id));

          return asDomainArray<AuthConnection>(rows);
        },
      ),

    getById: (connectionId: AuthConnection["id"]) =>
      rowEffect(
        backend,
        "rows.auth_connections.get_by_id",
        tableNames.authConnections,
        async () => {
          const row = await db
            .select()
            .from(tables.authConnectionsTable)
            .where(eq(tables.authConnectionsTable.id, connectionId))
            .limit(1);

          return row[0]
            ? Option.some(asDomain<AuthConnection>(row[0]))
            : Option.none<AuthConnection>();
        },
      ),

    listByOrganizationId: (organizationId: AuthConnection["organizationId"]) =>
      rowEffect(
        backend,
        "rows.auth_connections.list_by_organization",
        tableNames.authConnections,
        async () => {
          const rows = await db
            .select()
            .from(tables.authConnectionsTable)
            .where(eq(tables.authConnectionsTable.organizationId, organizationId))
            .orderBy(asc(tables.authConnectionsTable.updatedAt), asc(tables.authConnectionsTable.id));

          return asDomainArray<AuthConnection>(rows);
        },
      ),

    upsert: (connection: AuthConnection) =>
      rowEffect(
        backend,
        "rows.auth_connections.upsert",
        tableNames.authConnections,
        async () => {
          await db
            .insert(tables.authConnectionsTable)
            .values(connection)
            .onConflictDoUpdate({
              target: tables.authConnectionsTable.id,
              set: withoutCreatedAt(connection),
            });
        },
      ),

    removeById: (connectionId: AuthConnection["id"]) =>
      rowEffect(
        backend,
        "rows.auth_connections.remove",
        tableNames.authConnections,
        async () => {
          const deleted = await db
            .delete(tables.authConnectionsTable)
            .where(eq(tables.authConnectionsTable.id, connectionId))
            .returning();

          return deleted.length > 0;
        },
      ),
  },

  sourceAuthBindings: {
    list: () =>
      rowEffect(
        backend,
        "rows.source_auth_bindings.list",
        tableNames.sourceAuthBindings,
        async () => {
          const rows = await db
            .select()
            .from(tables.sourceAuthBindingsTable)
            .orderBy(
              asc(tables.sourceAuthBindingsTable.updatedAt),
              asc(tables.sourceAuthBindingsTable.id),
            );

          return asDomainArray<SourceAuthBinding>(rows);
        },
      ),

    getById: (bindingId: SourceAuthBinding["id"]) =>
      rowEffect(
        backend,
        "rows.source_auth_bindings.get_by_id",
        tableNames.sourceAuthBindings,
        async () => {
          const row = await db
            .select()
            .from(tables.sourceAuthBindingsTable)
            .where(eq(tables.sourceAuthBindingsTable.id, bindingId))
            .limit(1);

          return row[0]
            ? Option.some(asDomain<SourceAuthBinding>(row[0]))
            : Option.none<SourceAuthBinding>();
        },
      ),

    listByConnectionId: (connectionId: SourceAuthBinding["connectionId"]) =>
      rowEffect(
        backend,
        "rows.source_auth_bindings.list_by_connection",
        tableNames.sourceAuthBindings,
        async () => {
          const rows = await db
            .select()
            .from(tables.sourceAuthBindingsTable)
            .where(eq(tables.sourceAuthBindingsTable.connectionId, connectionId))
            .orderBy(
              asc(tables.sourceAuthBindingsTable.updatedAt),
              asc(tables.sourceAuthBindingsTable.id),
            );

          return asDomainArray<SourceAuthBinding>(rows);
        },
      ),

    listByWorkspaceScope: (
      workspaceId: Workspace["id"],
      organizationId: Organization["id"],
    ) =>
      rowEffect(
        backend,
        "rows.source_auth_bindings.list_by_workspace_scope",
        tableNames.sourceAuthBindings,
        async () => {
          const rows = await db
            .select()
            .from(tables.sourceAuthBindingsTable)
            .where(
              or(
                eq(tables.sourceAuthBindingsTable.workspaceId, workspaceId),
                and(
                  isNull(tables.sourceAuthBindingsTable.workspaceId),
                  eq(tables.sourceAuthBindingsTable.organizationId, organizationId),
                ),
              ),
            )
            .orderBy(
              desc(tables.sourceAuthBindingsTable.updatedAt),
              desc(tables.sourceAuthBindingsTable.createdAt),
            );

          return asDomainArray<SourceAuthBinding>(rows);
        },
      ),

    upsert: (binding: SourceAuthBinding) =>
      rowEffect(
        backend,
        "rows.source_auth_bindings.upsert",
        tableNames.sourceAuthBindings,
        async () => {
          await db
            .insert(tables.sourceAuthBindingsTable)
            .values(binding)
            .onConflictDoUpdate({
              target: tables.sourceAuthBindingsTable.id,
              set: withoutCreatedAt(binding),
            });
        },
      ),

    removeById: (bindingId: SourceAuthBinding["id"]) =>
      rowEffect(
        backend,
        "rows.source_auth_bindings.remove",
        tableNames.sourceAuthBindings,
        async () => {
          const deleted = await db
            .delete(tables.sourceAuthBindingsTable)
            .where(eq(tables.sourceAuthBindingsTable.id, bindingId))
            .returning();

          return deleted.length > 0;
        },
      ),
  },

  authMaterials: {
    list: () =>
      rowEffect(backend, "rows.auth_materials.list", tableNames.authMaterials, async () => {
        const rows = await db
          .select()
          .from(tables.authMaterialsTable)
          .orderBy(asc(tables.authMaterialsTable.updatedAt), asc(tables.authMaterialsTable.id));

        return asDomainArray<AuthMaterial>(rows);
      }),

    getByConnectionId: (connectionId: AuthMaterial["connectionId"]) =>
      rowEffect(
        backend,
        "rows.auth_materials.get_by_connection",
        tableNames.authMaterials,
        async () => {
          const row = await db
            .select()
            .from(tables.authMaterialsTable)
            .where(eq(tables.authMaterialsTable.connectionId, connectionId))
            .limit(1);

          return row[0]
            ? Option.some(asDomain<AuthMaterial>(row[0]))
            : Option.none<AuthMaterial>();
        },
      ),

    upsert: (material: AuthMaterial) =>
      rowEffect(
        backend,
        "rows.auth_materials.upsert",
        tableNames.authMaterials,
        async () => {
          await db
            .insert(tables.authMaterialsTable)
            .values(material)
            .onConflictDoUpdate({
              target: tables.authMaterialsTable.id,
              set: withoutCreatedAt(material),
            });
        },
      ),

    removeByConnectionId: (connectionId: AuthMaterial["connectionId"]) =>
      rowEffect(
        backend,
        "rows.auth_materials.remove_by_connection",
        tableNames.authMaterials,
        async () => {
          await db
            .delete(tables.authMaterialsTable)
            .where(eq(tables.authMaterialsTable.connectionId, connectionId));
        },
      ),
  },

  oauthStates: {
    list: () =>
      rowEffect(backend, "rows.oauth_states.list", tableNames.oauthStates, async () => {
        const rows = await db
          .select()
          .from(tables.oauthStatesTable)
          .orderBy(asc(tables.oauthStatesTable.updatedAt), asc(tables.oauthStatesTable.id));

        return asDomainArray<OAuthState>(rows);
      }),

    getByConnectionId: (connectionId: OAuthState["connectionId"]) =>
      rowEffect(
        backend,
        "rows.oauth_states.get_by_connection",
        tableNames.oauthStates,
        async () => {
          const row = await db
            .select()
            .from(tables.oauthStatesTable)
            .where(eq(tables.oauthStatesTable.connectionId, connectionId))
            .limit(1);

          return row[0]
            ? Option.some(asDomain<OAuthState>(row[0]))
            : Option.none<OAuthState>();
        },
      ),

    upsert: (state: OAuthState) =>
      rowEffect(backend, "rows.oauth_states.upsert", tableNames.oauthStates, async () => {
        await db
          .insert(tables.oauthStatesTable)
          .values(state)
          .onConflictDoUpdate({
            target: tables.oauthStatesTable.id,
            set: withoutCreatedAt(state),
          });
      }),

    removeByConnectionId: (connectionId: OAuthState["connectionId"]) =>
      rowEffect(
        backend,
        "rows.oauth_states.remove_by_connection",
        tableNames.oauthStates,
        async () => {
          await db
            .delete(tables.oauthStatesTable)
            .where(eq(tables.oauthStatesTable.connectionId, connectionId));
        },
      ),
  },

  secretMaterials: {
    list: () =>
      rowEffect(
        backend,
        "rows.secret_materials.list",
        tableNames.secretMaterials,
        async () => {
          const rows = await db
            .select()
            .from(tables.secretMaterialsTable)
            .orderBy(asc(tables.secretMaterialsTable.updatedAt), asc(tables.secretMaterialsTable.handle));

          return asDomainArray<SecretMaterial>(rows);
        },
      ),

    getByHandle: (handle: SecretMaterial["handle"]) =>
      rowEffect(
        backend,
        "rows.secret_materials.get_by_handle",
        tableNames.secretMaterials,
        async () => {
          const row = await db
            .select()
            .from(tables.secretMaterialsTable)
            .where(eq(tables.secretMaterialsTable.handle, handle))
            .limit(1);

          return row[0]
            ? Option.some(asDomain<SecretMaterial>(row[0]))
            : Option.none<SecretMaterial>();
        },
      ),

    upsert: (material: SecretMaterial) =>
      rowEffect(
        backend,
        "rows.secret_materials.upsert",
        tableNames.secretMaterials,
        async () => {
          await db
            .insert(tables.secretMaterialsTable)
            .values(material)
            .onConflictDoUpdate({
              target: tables.secretMaterialsTable.handle,
              set: withoutCreatedAt(material),
            });
        },
      ),

    removeByHandle: (handle: SecretMaterial["handle"]) =>
      rowEffect(
        backend,
        "rows.secret_materials.remove_by_handle",
        tableNames.secretMaterials,
        async () => {
          await db
            .delete(tables.secretMaterialsTable)
            .where(eq(tables.secretMaterialsTable.handle, handle));
        },
      ),
  },

  storageInstances: {
    list: () =>
      rowEffect(
        backend,
        "rows.storage_instances.list",
        tableNames.storageInstances,
        async () => {
          const rows = await db
            .select()
            .from(tables.storageInstancesTable)
            .orderBy(asc(tables.storageInstancesTable.updatedAt), asc(tables.storageInstancesTable.id));

          return asDomainArray<StorageInstance>(rows);
        },
      ),

    getById: (storageInstanceId: StorageInstance["id"]) =>
      rowEffect(
        backend,
        "rows.storage_instances.get_by_id",
        tableNames.storageInstances,
        async () => {
          const row = await db
            .select()
            .from(tables.storageInstancesTable)
            .where(eq(tables.storageInstancesTable.id, storageInstanceId))
            .limit(1);

          return row[0]
            ? Option.some(asDomain<StorageInstance>(row[0]))
            : Option.none<StorageInstance>();
        },
      ),

    listByWorkspaceScope: (
      workspaceId: Workspace["id"],
      organizationId: Organization["id"],
    ) =>
      rowEffect(
        backend,
        "rows.storage_instances.list_by_workspace_scope",
        tableNames.storageInstances,
        async () => {
          const rows = await db
            .select()
            .from(tables.storageInstancesTable)
            .where(
              or(
                eq(tables.storageInstancesTable.workspaceId, workspaceId),
                and(
                  isNull(tables.storageInstancesTable.workspaceId),
                  eq(tables.storageInstancesTable.organizationId, organizationId),
                ),
              ),
            )
            .orderBy(
              desc(tables.storageInstancesTable.updatedAt),
              asc(tables.storageInstancesTable.id),
            );

          return asDomainArray<StorageInstance>(rows);
        },
      ),

    upsert: (storageInstance: StorageInstance) =>
      rowEffect(
        backend,
        "rows.storage_instances.upsert",
        tableNames.storageInstances,
        async () => {
          await db
            .insert(tables.storageInstancesTable)
            .values(storageInstance)
            .onConflictDoUpdate({
              target: tables.storageInstancesTable.id,
              set: withoutCreatedAt(storageInstance),
            });
        },
      ),

    removeById: (storageInstanceId: StorageInstance["id"]) =>
      rowEffect(
        backend,
        "rows.storage_instances.remove",
        tableNames.storageInstances,
        async () => {
          const deleted = await db
            .delete(tables.storageInstancesTable)
            .where(eq(tables.storageInstancesTable.id, storageInstanceId))
            .returning();

          return deleted.length > 0;
        },
      ),
  },

  policies: {
    list: () =>
      rowEffect(backend, "rows.policies.list", tableNames.policies, async () => {
        const rows = await db
          .select()
          .from(tables.policiesTable)
          .orderBy(asc(tables.policiesTable.updatedAt), asc(tables.policiesTable.id));

        return asDomainArray<Policy>(rows);
      }),

    listByWorkspaceId: (workspaceId: Policy["workspaceId"]) =>
      rowEffect(
        backend,
        "rows.policies.list_by_workspace",
        tableNames.policies,
        async () => {
          const rows = await db
            .select()
            .from(tables.policiesTable)
            .where(eq(tables.policiesTable.workspaceId, workspaceId))
            .orderBy(asc(tables.policiesTable.updatedAt), asc(tables.policiesTable.id));

          return asDomainArray<Policy>(rows);
        },
      ),

    getById: (policyId: Policy["id"]) =>
      rowEffect(backend, "rows.policies.get_by_id", tableNames.policies, async () => {
        const row = await db
          .select()
          .from(tables.policiesTable)
          .where(eq(tables.policiesTable.id, policyId))
          .limit(1);

        return row[0] ? Option.some(asDomain<Policy>(row[0])) : Option.none<Policy>();
      }),

    upsert: (policy: Policy) =>
      rowEffect(backend, "rows.policies.upsert", tableNames.policies, async () => {
        await db
          .insert(tables.policiesTable)
          .values(policy)
          .onConflictDoUpdate({
            target: tables.policiesTable.id,
            set: withoutCreatedAt(policy),
          });
      }),

    removeById: (policyId: Policy["id"]) =>
      rowEffect(backend, "rows.policies.remove", tableNames.policies, async () => {
        const deleted = await db
          .delete(tables.policiesTable)
          .where(eq(tables.policiesTable.id, policyId))
          .returning();

        return deleted.length > 0;
      }),
  },

  interactions: {
    list: () =>
      rowEffect(backend, "rows.interactions.list", tableNames.interactions, async () => {
        const rows = await db
          .select()
          .from(tables.interactionsTable)
          .orderBy(desc(tables.interactionsTable.requestedAt), desc(tables.interactionsTable.id));

        return asDomainArray<Interaction>(rows);
      }),

    listByWorkspaceId: (workspaceId: Interaction["workspaceId"]) =>
      rowEffect(
        backend,
        "rows.interactions.list_by_workspace",
        tableNames.interactions,
        async () => {
          const rows = await db
            .select()
            .from(tables.interactionsTable)
            .where(eq(tables.interactionsTable.workspaceId, workspaceId))
            .orderBy(desc(tables.interactionsTable.requestedAt), desc(tables.interactionsTable.id));

          return asDomainArray<Interaction>(rows);
        },
      ),

    listByRunId: (
      workspaceId: Interaction["workspaceId"],
      taskRunId: Interaction["taskRunId"],
    ) =>
      rowEffect(
        backend,
        "rows.interactions.list_by_run",
        tableNames.interactions,
        async () => {
          const rows = await db
            .select()
            .from(tables.interactionsTable)
            .where(
              and(
                eq(tables.interactionsTable.workspaceId, workspaceId),
                eq(tables.interactionsTable.taskRunId, taskRunId),
              ),
            )
            .orderBy(desc(tables.interactionsTable.requestedAt), desc(tables.interactionsTable.id));

          return asDomainArray<Interaction>(rows);
        },
      ),

    getById: (interactionId: Interaction["id"]) =>
      rowEffect(
        backend,
        "rows.interactions.get_by_id",
        tableNames.interactions,
        async () => {
          const row = await db
            .select()
            .from(tables.interactionsTable)
            .where(eq(tables.interactionsTable.id, interactionId))
            .limit(1);

          return row[0]
            ? Option.some(asDomain<Interaction>(row[0]))
            : Option.none<Interaction>();
        },
      ),

    findByRunAndCall: (
      workspaceId: Interaction["workspaceId"],
      taskRunId: Interaction["taskRunId"],
      callId: Interaction["callId"],
    ) =>
      rowEffect(
        backend,
        "rows.interactions.find_by_run_and_call",
        tableNames.interactions,
        async () => {
          const row = await db
            .select()
            .from(tables.interactionsTable)
            .where(
              and(
                eq(tables.interactionsTable.workspaceId, workspaceId),
                eq(tables.interactionsTable.taskRunId, taskRunId),
                eq(tables.interactionsTable.callId, callId),
              ),
            )
            .orderBy(desc(tables.interactionsTable.requestedAt))
            .limit(1);

          return row[0]
            ? Option.some(asDomain<Interaction>(row[0]))
            : Option.none<Interaction>();
        },
      ),

    upsert: (interaction: Interaction) =>
      rowEffect(backend, "rows.interactions.upsert", tableNames.interactions, async () => {
        await db
          .insert(tables.interactionsTable)
          .values(interaction)
          .onConflictDoUpdate({
            target: tables.interactionsTable.id,
            set: interaction,
          });
      }),
  },
});
