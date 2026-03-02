import { type SqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import {
  makeControlPlaneOrganizationsService,
  type ControlPlaneOrganizationsServiceShape,
} from "@executor-v2/management-api";
import {
  type Organization,
  type OrganizationMembership,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import { createSqlSourceStoreErrorMapper } from "./control-plane-row-helpers";

type OrganizationRows = Pick<
  SqlControlPlanePersistence["rows"],
  "organizations" | "organizationMemberships"
>;

const sourceStoreError = createSqlSourceStoreErrorMapper("organizations");

const sortOrganizations = (
  organizations: ReadonlyArray<Organization>,
): Array<Organization> =>
  [...organizations].sort((left, right) => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName === rightName) {
      return left.id.localeCompare(right.id);
    }

    return leftName.localeCompare(rightName);
  });

export const createPmOrganizationsService = (
  rows: OrganizationRows,
): ControlPlaneOrganizationsServiceShape =>
  makeControlPlaneOrganizationsService({
    listOrganizations: () =>
      Effect.gen(function* () {
        const organizations = yield* rows.organizations.list().pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("organizations.list", error),
          ),
        );

        return sortOrganizations(organizations);
      }),

    upsertOrganization: (input) =>
      Effect.gen(function* () {
        const organizations = yield* rows.organizations.list().pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("organizations.upsert", error),
          ),
        );

        const memberships = yield* rows.organizationMemberships.list().pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore(
              "organizations.memberships.list",
              error,
            ),
          ),
        );

        const now = Date.now();
        const existingIndex = input.payload.id
          ? organizations.findIndex((organization) => organization.id === input.payload.id)
          : organizations.findIndex(
              (organization) => organization.slug === input.payload.slug,
            );
        const existing = existingIndex >= 0 ? organizations[existingIndex] : null;

        const nextOrganization: Organization = {
          id:
            existing?.id
            ?? (input.payload.id ?? (`org_${crypto.randomUUID()}` as Organization["id"])),
          slug: input.payload.slug,
          name: input.payload.name,
          status: input.payload.status ?? existing?.status ?? "active",
          createdByAccountId:
            existing?.createdByAccountId
            ?? input.payload.createdByAccountId
            ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        yield* rows.organizations.upsert(nextOrganization).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("organizations.upsert_write", error),
          ),
        );

        if (existing === null && nextOrganization.createdByAccountId !== null) {
          const existingMembership = memberships.find(
            (membership) =>
              membership.organizationId === nextOrganization.id
              && membership.accountId === nextOrganization.createdByAccountId,
          );

          if (!existingMembership) {
            const membership: OrganizationMembership = {
              id: `org_member_${crypto.randomUUID()}` as OrganizationMembership["id"],
              organizationId: nextOrganization.id,
              accountId: nextOrganization.createdByAccountId,
              role: "owner",
              status: "active",
              billable: false,
              invitedByAccountId: null,
              joinedAt: now,
              createdAt: now,
              updatedAt: now,
            };

            yield* rows.organizationMemberships.upsert(membership).pipe(
              Effect.mapError((error) =>
                sourceStoreError.fromRowStore(
                  "organizations.membership_upsert_write",
                  error,
                ),
              ),
            );
          }
        }

        return nextOrganization;
      }),
  });
