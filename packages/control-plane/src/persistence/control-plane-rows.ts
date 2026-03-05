import {
  type Organization,
  type OrganizationMembership,
  type Policy,
  type Source,
  type Workspace,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { and, asc, desc, eq } from "drizzle-orm";

import {
  ControlPlanePersistenceError,
  toPersistenceError,
} from "./persistence-errors";
import { tableNames, type DrizzleTables } from "./schema";
import type { SqlBackend } from "./sql-runtime";

type CreateControlPlaneRowsInput = {
  backend: SqlBackend;
  db: any;
  tables: DrizzleTables;
};

const asDomain = <A>(value: unknown): A => value as A;
const asDomainArray = <A>(value: ReadonlyArray<unknown>): Array<A> =>
  value as Array<A>;

const withoutCreatedAt = <A extends { createdAt: unknown }>(
  value: A,
): Omit<A, "createdAt"> => {
  const { createdAt: _createdAt, ...rest } = value;
  return rest;
};

const rowEffect = <A>(
  _backend: SqlBackend,
  operation: string,
  _location: string,
  run: () => Promise<A>,
): Effect.Effect<A, ControlPlanePersistenceError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => toPersistenceError(operation, cause),
  });

export const createControlPlaneRows = ({
  backend,
  db,
  tables,
}: CreateControlPlaneRowsInput) => ({
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
      rowEffect(
        backend,
        "rows.organizations.get_by_id",
        tableNames.organizations,
        async () => {
          const row = await db
            .select()
            .from(tables.organizationsTable)
            .where(eq(tables.organizationsTable.id, organizationId))
            .limit(1);

          return row[0]
            ? Option.some(asDomain<Organization>(row[0]))
            : Option.none<Organization>();
        },
      ),

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

    insert: (organization: Organization) =>
      rowEffect(backend, "rows.organizations.insert", tableNames.organizations, async () => {
        await db.insert(tables.organizationsTable).values(organization);
      }),

    insertWithOwnerMembership: (
      organization: Organization,
      ownerMembership: OrganizationMembership | null,
    ) =>
      rowEffect(
        backend,
        "rows.organizations.insert_with_owner_membership",
        tableNames.organizations,
        async () => {
          await db.transaction(async (tx: any) => {
            await tx.insert(tables.organizationsTable).values(organization);

            if (ownerMembership !== null) {
              await tx
                .insert(tables.organizationMembershipsTable)
                .values(ownerMembership)
                .onConflictDoUpdate({
                  target: [
                    tables.organizationMembershipsTable.organizationId,
                    tables.organizationMembershipsTable.accountId,
                  ],
                  set: {
                    ...withoutCreatedAt(ownerMembership),
                    id: ownerMembership.id,
                  },
                });
            }
          });
        },
      ),

    update: (
      organizationId: Organization["id"],
      patch: Partial<Omit<Organization, "id" | "createdAt">>,
    ) =>
      rowEffect(backend, "rows.organizations.update", tableNames.organizations, async () => {
        const rows = await db
          .update(tables.organizationsTable)
          .set(patch)
          .where(eq(tables.organizationsTable.id, organizationId))
          .returning();

        return rows[0]
          ? Option.some(asDomain<Organization>(rows[0]))
          : Option.none<Organization>();
      }),

    removeById: (organizationId: Organization["id"]) =>
      rowEffect(backend, "rows.organizations.remove", tableNames.organizations, async () => {
        const deleted = await db
          .delete(tables.organizationsTable)
          .where(eq(tables.organizationsTable.id, organizationId))
          .returning();

        return deleted.length > 0;
      }),

    removeTreeById: (organizationId: Organization["id"]) =>
      rowEffect(
        backend,
        "rows.organizations.remove_tree",
        tableNames.organizations,
        async () => {
          return await db.transaction(async (tx: any) => {
            const workspaces = await tx
              .select({ id: tables.workspacesTable.id })
              .from(tables.workspacesTable)
              .where(eq(tables.workspacesTable.organizationId, organizationId));

            for (const workspace of workspaces) {
              await tx
                .delete(tables.sourcesTable)
                .where(eq(tables.sourcesTable.workspaceId, workspace.id));
              await tx
                .delete(tables.policiesTable)
                .where(eq(tables.policiesTable.workspaceId, workspace.id));
            }

            await tx
              .delete(tables.workspacesTable)
              .where(eq(tables.workspacesTable.organizationId, organizationId));

            await tx
              .delete(tables.organizationMembershipsTable)
              .where(eq(tables.organizationMembershipsTable.organizationId, organizationId));

            const deleted = await tx
              .delete(tables.organizationsTable)
              .where(eq(tables.organizationsTable.id, organizationId))
              .returning();

            return deleted.length > 0;
          });
        },
      ),
  },

  organizationMemberships: {
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
              target: [
                tables.organizationMembershipsTable.organizationId,
                tables.organizationMembershipsTable.accountId,
              ],
              set: {
                ...withoutCreatedAt(membership),
                id: membership.id,
              },
            });
        },
      ),

    removeByOrganizationAndAccount: (
      organizationId: OrganizationMembership["organizationId"],
      accountId: OrganizationMembership["accountId"],
    ) =>
      rowEffect(
        backend,
        "rows.organization_memberships.remove",
        tableNames.organizationMemberships,
        async () => {
          const deleted = await db
            .delete(tables.organizationMembershipsTable)
            .where(
              and(
                eq(tables.organizationMembershipsTable.organizationId, organizationId),
                eq(tables.organizationMembershipsTable.accountId, accountId),
              ),
            )
            .returning();

          return deleted.length > 0;
        },
      ),
  },

  workspaces: {
    listByOrganizationId: (organizationId: Workspace["organizationId"]) =>
      rowEffect(backend, "rows.workspaces.list_by_organization", tableNames.workspaces, async () => {
        const rows = await db
          .select()
          .from(tables.workspacesTable)
          .where(eq(tables.workspacesTable.organizationId, organizationId))
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

        return row[0]
          ? Option.some(asDomain<Workspace>(row[0]))
          : Option.none<Workspace>();
      }),

    insert: (workspace: Workspace) =>
      rowEffect(backend, "rows.workspaces.insert", tableNames.workspaces, async () => {
        await db.insert(tables.workspacesTable).values(workspace);
      }),

    update: (
      workspaceId: Workspace["id"],
      patch: Partial<Omit<Workspace, "id" | "createdAt">>,
    ) =>
      rowEffect(backend, "rows.workspaces.update", tableNames.workspaces, async () => {
        const rows = await db
          .update(tables.workspacesTable)
          .set(patch)
          .where(eq(tables.workspacesTable.id, workspaceId))
          .returning();

        return rows[0]
          ? Option.some(asDomain<Workspace>(rows[0]))
          : Option.none<Workspace>();
      }),

    removeById: (workspaceId: Workspace["id"]) =>
      rowEffect(backend, "rows.workspaces.remove", tableNames.workspaces, async () => {
        const deleted = await db
          .delete(tables.workspacesTable)
          .where(eq(tables.workspacesTable.id, workspaceId))
          .returning();

        return deleted.length > 0;
      }),
  },

  sources: {
    listByWorkspaceId: (workspaceId: Source["workspaceId"]) =>
      rowEffect(backend, "rows.sources.list_by_workspace", tableNames.sources, async () => {
        const rows = await db
          .select()
          .from(tables.sourcesTable)
          .where(eq(tables.sourcesTable.workspaceId, workspaceId))
          .orderBy(asc(tables.sourcesTable.updatedAt), asc(tables.sourcesTable.sourceId));

        return rows.map((row: any) =>
          asDomain<Source>({
            id: row.sourceId,
            workspaceId: row.workspaceId,
            name: row.name,
            kind: row.kind,
            endpoint: row.endpoint,
            status: row.status,
            enabled: row.enabled,
            configJson: row.configJson,
            sourceHash: row.sourceHash,
            lastError: row.lastError,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }),
        );
      }),

    getByWorkspaceAndId: (
      workspaceId: Source["workspaceId"],
      sourceId: Source["id"],
    ) =>
      rowEffect(backend, "rows.sources.get_by_workspace_and_id", tableNames.sources, async () => {
        const rows = await db
          .select()
          .from(tables.sourcesTable)
          .where(
            and(
              eq(tables.sourcesTable.workspaceId, workspaceId),
              eq(tables.sourcesTable.sourceId, sourceId),
            ),
          )
          .limit(1);

        const row = rows[0];
        if (!row) {
          return Option.none<Source>();
        }

        return Option.some(
          asDomain<Source>({
            id: row.sourceId,
            workspaceId: row.workspaceId,
            name: row.name,
            kind: row.kind,
            endpoint: row.endpoint,
            status: row.status,
            enabled: row.enabled,
            configJson: row.configJson,
            sourceHash: row.sourceHash,
            lastError: row.lastError,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }),
        );
      }),

    insert: (source: Source) =>
      rowEffect(backend, "rows.sources.insert", tableNames.sources, async () => {
        await db.insert(tables.sourcesTable).values({
          workspaceId: source.workspaceId,
          sourceId: source.id,
          name: source.name,
          kind: source.kind,
          endpoint: source.endpoint,
          status: source.status,
          enabled: source.enabled,
          configJson: source.configJson,
          sourceHash: source.sourceHash,
          lastError: source.lastError,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
        });
      }),

    update: (
      workspaceId: Source["workspaceId"],
      sourceId: Source["id"],
      patch: Partial<Omit<Source, "id" | "workspaceId" | "createdAt">>,
    ) =>
      rowEffect(backend, "rows.sources.update", tableNames.sources, async () => {
        const updateSet: Record<string, unknown> = { ...patch };
        if ("id" in updateSet) {
          delete updateSet.id;
        }
        if ("workspaceId" in updateSet) {
          delete updateSet.workspaceId;
        }

        const rows = await db
          .update(tables.sourcesTable)
          .set(updateSet)
          .where(
            and(
              eq(tables.sourcesTable.workspaceId, workspaceId),
              eq(tables.sourcesTable.sourceId, sourceId),
            ),
          )
          .returning();

        const row = rows[0];
        if (!row) {
          return Option.none<Source>();
        }

        return Option.some(
          asDomain<Source>({
            id: row.sourceId,
            workspaceId: row.workspaceId,
            name: row.name,
            kind: row.kind,
            endpoint: row.endpoint,
            status: row.status,
            enabled: row.enabled,
            configJson: row.configJson,
            sourceHash: row.sourceHash,
            lastError: row.lastError,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }),
        );
      }),

    removeByWorkspaceAndId: (
      workspaceId: Source["workspaceId"],
      sourceId: Source["id"],
    ) =>
      rowEffect(backend, "rows.sources.remove", tableNames.sources, async () => {
        const deleted = await db
          .delete(tables.sourcesTable)
          .where(
            and(
              eq(tables.sourcesTable.workspaceId, workspaceId),
              eq(tables.sourcesTable.sourceId, sourceId),
            ),
          )
          .returning();

        return deleted.length > 0;
      }),
  },

  policies: {
    listByWorkspaceId: (workspaceId: Policy["workspaceId"]) =>
      rowEffect(backend, "rows.policies.list_by_workspace", tableNames.policies, async () => {
        const rows = await db
          .select()
          .from(tables.policiesTable)
          .where(eq(tables.policiesTable.workspaceId, workspaceId))
          .orderBy(desc(tables.policiesTable.priority), asc(tables.policiesTable.updatedAt));

        return asDomainArray<Policy>(rows);
      }),

    getById: (policyId: Policy["id"]) =>
      rowEffect(backend, "rows.policies.get_by_id", tableNames.policies, async () => {
        const row = await db
          .select()
          .from(tables.policiesTable)
          .where(eq(tables.policiesTable.id, policyId))
          .limit(1);

        return row[0] ? Option.some(asDomain<Policy>(row[0])) : Option.none<Policy>();
      }),

    insert: (policy: Policy) =>
      rowEffect(backend, "rows.policies.insert", tableNames.policies, async () => {
        await db.insert(tables.policiesTable).values(policy);
      }),

    update: (
      policyId: Policy["id"],
      patch: Partial<Omit<Policy, "id" | "workspaceId" | "createdAt">>,
    ) =>
      rowEffect(backend, "rows.policies.update", tableNames.policies, async () => {
        const rows = await db
          .update(tables.policiesTable)
          .set(patch)
          .where(eq(tables.policiesTable.id, policyId))
          .returning();

        return rows[0] ? Option.some(asDomain<Policy>(rows[0])) : Option.none<Policy>();
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
});

export type SqlControlPlaneRows = ReturnType<typeof createControlPlaneRows>;
