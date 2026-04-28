import { Context, Effect, Layer } from "effect";

import { UserStoreService } from "../auth/context";
import { WorkOSError, type UserStoreError } from "../auth/errors";
import { WorkOSAuth } from "../auth/workos";
import { IdentityProvider } from "./provider";

type IdentityEvent = {
  readonly id: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
};

type UserData = {
  readonly id: string;
  readonly email?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly profilePictureUrl?: string | null;
};

type OrganizationData = {
  readonly id: string;
  readonly name: string;
  readonly externalId?: string | null;
};

type MembershipData = {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName?: string | null;
  readonly status: string;
  readonly role?: { readonly slug?: string | null } | null;
};

export class IdentitySync extends Context.Tag("@executor/cloud/IdentitySync")<
  IdentitySync,
  {
    readonly applyEvent: (
      event: IdentityEvent,
    ) => Effect.Effect<"processed" | "duplicate" | "ignored", UserStoreError | WorkOSError>;
    readonly constructAndApplyWebhook: (
      request: Request,
      secret: string,
    ) => Effect.Effect<"processed" | "duplicate" | "ignored", UserStoreError | WorkOSError>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const users = yield* UserStoreService;
      const provider = yield* IdentityProvider;
      const workos = yield* WorkOSAuth;

      const upsertAccount = (data: UserData) =>
        users.use((store) =>
          store.ensureAccount({
            id: data.id,
            email: data.email ?? null,
            name: [data.firstName, data.lastName].filter(Boolean).join(" ") || null,
            avatarUrl: data.profilePictureUrl ?? null,
            externalId: data.id,
            identityProvider: "workos",
          }),
        );

      const upsertOrganization = (data: OrganizationData) =>
        users.use((store) =>
          store.upsertOrganization({
            id: data.id,
            name: data.name,
            externalId: data.externalId ?? data.id,
            identityProvider: "workos",
          }),
        );

      const upsertMembership = (data: MembershipData) =>
        Effect.gen(function* () {
          yield* users.use((store) =>
            store.ensureAccount({
              id: data.userId,
              externalId: data.userId,
              identityProvider: "workos",
            }),
          );

          const existingOrg = yield* users.use((store) => store.getOrganization(data.organizationId));
          if (!existingOrg) {
            if (data.organizationName) {
              yield* upsertOrganization({ id: data.organizationId, name: data.organizationName });
            } else {
              const org = yield* provider.getOrganization(data.organizationId);
              yield* upsertOrganization({ id: org.id, name: org.name });
            }
          }

          yield* users.use((store) =>
            store.upsertMembership({
              accountId: data.userId,
              organizationId: data.organizationId,
              externalId: data.id,
              identityProvider: "workos",
              status: data.status,
              roleSlug: data.role?.slug ?? "member",
            }),
          );
        });

      const applyEvent = (event: IdentityEvent) =>
        Effect.gen(function* () {
          const inserted = yield* users.use((store) =>
            store.recordIdentityEvent({
              provider: "workos",
              eventId: event.id,
              eventType: event.event,
            }),
          );
          if (!inserted) return "duplicate" as const;

          switch (event.event) {
            case "user.created":
            case "user.updated":
              yield* upsertAccount(event.data as UserData);
              return "processed" as const;
            case "organization.created":
            case "organization.updated":
              yield* upsertOrganization(event.data as OrganizationData);
              return "processed" as const;
            case "organization_membership.created":
            case "organization_membership.updated":
              yield* upsertMembership(event.data as MembershipData);
              return "processed" as const;
            case "organization_membership.deleted": {
              const membership = event.data as MembershipData;
              yield* users.use((store) =>
                store.deactivateMembership(membership.userId, membership.organizationId),
              );
              return "processed" as const;
            }
            default:
              return "ignored" as const;
          }
        });

      return IdentitySync.of({
        applyEvent,
        constructAndApplyWebhook: (request, secret) =>
          Effect.gen(function* () {
            const signature = request.headers.get("workos-signature");
            if (!signature) return yield* new WorkOSError();
            const payload = yield* Effect.promise(() => request.json() as Promise<Record<string, unknown>>);
            const event = yield* workos.constructWebhookEvent(payload, signature, secret);
            return yield* applyEvent({
              id: String(event.id),
              event: event.event,
              data: event.data as Record<string, unknown>,
            });
          }),
      });
    }),
  );
}
