import { SourceStoreError } from "@executor-v2/persistence-ports";
import {
  makeControlPlaneOrganizationsService,
  type ControlPlaneOrganizationsServiceShape,
} from "@executor-v2/management-api";
import {
  type LocalStateSnapshot,
  type LocalStateStore,
  type LocalStateStoreError,
} from "@executor-v2/persistence-local";
import {
  type Organization,
  type OrganizationMembership,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const toSourceStoreError = (
  operation: string,
  message: string,
  details: string | null,
): SourceStoreError =>
  new SourceStoreError({
    operation,
    backend: "local-file",
    location: "snapshot.json",
    message,
    reason: null,
    details,
  });

const toSourceStoreErrorFromLocalState = (
  operation: string,
  error: LocalStateStoreError,
): SourceStoreError =>
  toSourceStoreError(operation, error.message, error.details ?? error.reason ?? null);

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

const replaceOrganizationAt = (
  snapshot: LocalStateSnapshot,
  index: number,
  organization: Organization,
): LocalStateSnapshot => {
  const next = [...snapshot.organizations];
  next[index] = organization;

  return {
    ...snapshot,
    generatedAt: Date.now(),
    organizations: next,
  };
};

const appendOrganization = (
  snapshot: LocalStateSnapshot,
  organization: Organization,
): LocalStateSnapshot => ({
  ...snapshot,
  generatedAt: Date.now(),
  organizations: [...snapshot.organizations, organization],
});

const appendOrganizationMembership = (
  snapshot: LocalStateSnapshot,
  membership: OrganizationMembership,
): LocalStateSnapshot => ({
  ...snapshot,
  generatedAt: Date.now(),
  organizationMemberships: [...snapshot.organizationMemberships, membership],
});

export const createPmOrganizationsService = (
  localStateStore: LocalStateStore,
): ControlPlaneOrganizationsServiceShape =>
  makeControlPlaneOrganizationsService({
    listOrganizations: () =>
      Effect.gen(function* () {
        const snapshotOption = yield* localStateStore.getSnapshot().pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("organizations.list", error),
          ),
        );

        const snapshot = Option.getOrNull(snapshotOption);
        if (snapshot === null) {
          return [];
        }

        return sortOrganizations(snapshot.organizations);
      }),

    upsertOrganization: (input) =>
      Effect.gen(function* () {
        const snapshotOption = yield* localStateStore.getSnapshot().pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("organizations.upsert", error),
          ),
        );

        const snapshot = Option.getOrNull(snapshotOption);
        if (snapshot === null) {
          return yield* toSourceStoreError(
            "organizations.upsert",
            "Organization snapshot not found",
            null,
          );
        }

        const now = Date.now();
        const existingIndex = input.payload.id
          ? snapshot.organizations.findIndex((organization) => organization.id === input.payload.id)
          : snapshot.organizations.findIndex(
              (organization) => organization.slug === input.payload.slug,
            );
        const existing = existingIndex >= 0 ? snapshot.organizations[existingIndex] : null;

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

        let nextSnapshot = existingIndex >= 0
          ? replaceOrganizationAt(snapshot, existingIndex, nextOrganization)
          : appendOrganization(snapshot, nextOrganization);

        if (existing === null && nextOrganization.createdByAccountId !== null) {
          const existingMembership = nextSnapshot.organizationMemberships.find(
            (membership) =>
              membership.organizationId === nextOrganization.id
              && membership.accountId === nextOrganization.createdByAccountId,
          );

          if (!existingMembership) {
            nextSnapshot = appendOrganizationMembership(nextSnapshot, {
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
            });
          }
        }

        yield* localStateStore.writeSnapshot(nextSnapshot).pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("organizations.upsert_write", error),
          ),
        );

        return nextOrganization;
      }),
  });
