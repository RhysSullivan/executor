import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { UserStoreService } from "../auth/context";
import { WorkOSAuth } from "../auth/workos";
import { IdentityProvider } from "./provider";
import { IdentitySync } from "./sync";
import type { IdentityOrganization } from "./types";

type AccountInput = {
  readonly id: string;
  readonly email?: string | null;
  readonly name?: string | null;
};

type OrgInput = {
  readonly id: string;
  readonly name: string;
};

type MembershipInput = {
  readonly accountId: string;
  readonly organizationId: string;
  readonly status?: string;
  readonly roleSlug?: string;
};

const makeSync = () => {
  const accounts = new Map<string, AccountInput>();
  const organizations = new Map<string, OrgInput>();
  const memberships = new Map<string, MembershipInput>();
  const events = new Set<string>();

  const UserStoreTest = Layer.succeed(UserStoreService, {
    use: <A>(fn: (store: {
      ensureAccount: (input: AccountInput) => Promise<AccountInput>;
      upsertOrganization: (input: OrgInput) => Promise<OrgInput>;
      getOrganization: (id: string) => Promise<OrgInput | null>;
      upsertMembership: (input: MembershipInput) => Promise<MembershipInput>;
      deactivateMembership: (
        accountId: string,
        organizationId: string,
      ) => Promise<MembershipInput | null>;
      recordIdentityEvent: (event: {
        provider: string;
        eventId: string;
        eventType: string;
      }) => Promise<boolean>;
    }) => Promise<A>) =>
      Effect.promise(() =>
        fn({
          ensureAccount: async (input) => {
            accounts.set(input.id, input);
            return input;
          },
          upsertOrganization: async (input) => {
            organizations.set(input.id, input);
            return input;
          },
          getOrganization: async (id) => organizations.get(id) ?? null,
          upsertMembership: async (input) => {
            memberships.set(`${input.accountId}:${input.organizationId}`, input);
            return input;
          },
          deactivateMembership: async (accountId, organizationId) => {
            const key = `${accountId}:${organizationId}`;
            const current = memberships.get(key);
            const next = current ? { ...current, status: "inactive" } : null;
            if (next) memberships.set(key, next);
            return next;
          },
          recordIdentityEvent: async (event) => {
            const key = `${event.provider}:${event.eventId}`;
            if (events.has(key)) return false;
            events.add(key);
            return true;
          },
        }),
      ),
  } as unknown as UserStoreService["Type"]);

  const IdentityProviderTest = Layer.succeed(IdentityProvider, {
    authenticateSealedSession: () => Effect.succeed(null),
    authenticateRequest: () => Effect.succeed(null),
    listUserMemberships: () => Effect.succeed([]),
    listOrganizationMembers: () => Effect.succeed([]),
    listOrganizationRoles: () => Effect.succeed([]),
    getOrganization: (organizationId: string) =>
      Effect.succeed({ id: organizationId, name: "Fetched Org" } satisfies IdentityOrganization),
    refreshSession: () => Effect.succeed(null),
  } as IdentityProvider["Type"]);

  const WorkOSTest = Layer.succeed(WorkOSAuth, {
    constructWebhookEvent: () => Effect.die("not used"),
  } as unknown as WorkOSAuth["Type"]);

  return {
    accounts,
    organizations,
    memberships,
    layer: IdentitySync.Live.pipe(
      Layer.provideMerge(UserStoreTest),
      Layer.provideMerge(IdentityProviderTest),
      Layer.provideMerge(WorkOSTest),
    ) as Layer.Layer<IdentitySync, never, never>,
  };
};

describe("IdentitySync", () => {
  it.effect("upserts users from WorkOS user events", () =>
    Effect.gen(function* () {
      const sync = makeSync();

      const result = yield* Effect.provide(
        Effect.gen(function* () {
          const service = yield* IdentitySync;
          return yield* service.applyEvent({
            id: "event_1",
            event: "user.created",
            data: {
              id: "user_1",
              email: "user@test.com",
              firstName: "Ada",
              lastName: "Lovelace",
            },
          });
        }),
        sync.layer,
      );

      expect(result).toBe("processed");
      expect(sync.accounts.get("user_1")).toMatchObject({
        email: "user@test.com",
        name: "Ada Lovelace",
      });
    }),
  );

  it.effect("deduplicates already processed events", () =>
    Effect.gen(function* () {
      const sync = makeSync();

      const program = Effect.gen(function* () {
        const service = yield* IdentitySync;
        const event = {
          id: "event_1",
          event: "organization.created",
          data: { id: "org_1", name: "Acme" },
        };
        return [yield* service.applyEvent(event), yield* service.applyEvent(event)] as const;
      });

      const results = yield* Effect.provide(program, sync.layer);

      expect(results).toEqual(["processed", "duplicate"]);
    }),
  );

  it.effect("upserts and deactivates memberships", () =>
    Effect.gen(function* () {
      const sync = makeSync();

      yield* Effect.provide(
        Effect.gen(function* () {
          const service = yield* IdentitySync;
          yield* service.applyEvent({
            id: "event_create",
            event: "organization_membership.created",
            data: {
              id: "mem_1",
              userId: "user_1",
              organizationId: "org_1",
              organizationName: "Acme",
              status: "active",
              role: { slug: "admin" },
            },
          });
          return yield* service.applyEvent({
            id: "event_delete",
            event: "organization_membership.deleted",
            data: {
              id: "mem_1",
              userId: "user_1",
              organizationId: "org_1",
              status: "inactive",
            },
          });
        }),
        sync.layer,
      );

      expect(sync.organizations.get("org_1")?.name).toBe("Acme");
      expect(sync.memberships.get("user_1:org_1")).toMatchObject({
        roleSlug: "admin",
        status: "inactive",
      });
    }),
  );
});
