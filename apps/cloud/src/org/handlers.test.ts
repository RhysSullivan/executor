import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AuthContext } from "../auth/middleware";
import { WorkOSAuth } from "../auth/workos";
import { Forbidden } from "./api";

// ---------------------------------------------------------------------------
// Stub factory — only implement what each test calls
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub needs wide function types
type StubFn = (...args: never[]) => Effect.Effect<any>;

type StubOverrides = {
  listOrgMembers?: StubFn;
  getUser?: StubFn;
  sendInvitation?: StubFn;
  deleteOrgMembership?: StubFn;
  updateOrgMembershipRole?: StubFn;
  listOrgRoles?: StubFn;
};

const stubWorkOS = (overrides: StubOverrides = {}) =>
  Layer.succeed(
    WorkOSAuth,
    new Proxy({} as WorkOSAuth["Type"], {
      get: (_target, prop) => {
        if (prop in overrides) return (overrides as Record<string, unknown>)[prop as string];
        return () => {
          throw new Error(`WorkOSAuth.${String(prop)} not stubbed`);
        };
      },
    }),
  );

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminAuth = {
  accountId: "user_admin",
  organizationId: "org_1",
  email: "admin@test.com",
  name: "Admin",
  avatarUrl: null,
};

const memberAuth = {
  accountId: "user_member",
  organizationId: "org_1",
  email: "member@test.com",
  name: "Member",
  avatarUrl: null,
};

type FakeMembership = {
  id: string;
  userId: string;
  status: string;
  role: { slug: string };
};
type FakeUser = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
  lastSignInAt: string | null;
};
type FakeRole = { slug: string; name: string };

const fakeMemberships: FakeMembership[] = [
  {
    id: "mem_admin",
    userId: "user_admin",
    status: "active",
    role: { slug: "admin" },
  },
  {
    id: "mem_member",
    userId: "user_member",
    status: "active",
    role: { slug: "member" },
  },
];

const fakeUsers: Record<string, FakeUser> = {
  user_admin: {
    email: "admin@test.com",
    firstName: "Admin",
    lastName: null,
    profilePictureUrl: null,
    lastSignInAt: "2026-04-09T00:00:00Z",
  },
  user_member: {
    email: "member@test.com",
    firstName: "Member",
    lastName: null,
    profilePictureUrl: null,
    lastSignInAt: null,
  },
};

const fakeRoles: FakeRole[] = [
  { slug: "admin", name: "Admin" },
  { slug: "member", name: "Member" },
];

// ---------------------------------------------------------------------------
// The admin guard — mirrors handlers.ts
// ---------------------------------------------------------------------------

const requireAdmin = Effect.gen(function* () {
  const auth = yield* AuthContext;
  const workos = yield* WorkOSAuth;
  const memberships = yield* workos.listOrgMembers(auth.organizationId);
  const current = memberships.data.find((m: FakeMembership) => m.userId === auth.accountId);
  if (!current || current.role?.slug !== "admin") {
    return yield* new Forbidden();
  }
});

const provide = (auth: typeof adminAuth, workosOverrides: StubOverrides = {}) =>
  Layer.mergeAll(Layer.succeed(AuthContext, auth), stubWorkOS(workosOverrides));

const withMembers: StubOverrides = {
  listOrgMembers: () => Effect.succeed({ data: fakeMemberships }),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Org handlers", () => {
  describe("listMembers", () => {
    it.effect("returns members with isCurrentUser set correctly", () =>
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        const workos = yield* WorkOSAuth;
        const result = yield* workos.listOrgMembers(auth.organizationId);
        const members = yield* Effect.all(
          result.data.map((m: FakeMembership) =>
            Effect.gen(function* () {
              const user = yield* workos.getUser(m.userId);
              return {
                id: m.id,
                email: user.email,
                role: m.role?.slug ?? "member",
                isCurrentUser: m.userId === auth.accountId,
              };
            }),
          ),
        );

        expect(members).toHaveLength(2);
        expect(members[0]).toMatchObject({
          email: "admin@test.com",
          isCurrentUser: true,
        });
        expect(members[1]).toMatchObject({
          email: "member@test.com",
          isCurrentUser: false,
        });
      }).pipe(
        Effect.provide(
          provide(adminAuth, {
            ...withMembers,
            getUser: (id: string) => Effect.succeed(fakeUsers[id]),
          }),
        ),
      ),
    );
  });

  describe("listRoles", () => {
    it.effect("returns available roles", () =>
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        const workos = yield* WorkOSAuth;
        const result = yield* workos.listOrgRoles(auth.organizationId);
        const roles = result.data.map((r: FakeRole) => ({
          slug: r.slug,
          name: r.name,
        }));

        expect(roles).toEqual(fakeRoles);
      }).pipe(
        Effect.provide(
          provide(adminAuth, {
            listOrgRoles: () => Effect.succeed({ data: fakeRoles }),
          }),
        ),
      ),
    );
  });

  describe("requireAdmin", () => {
    it.effect("passes for admin user", () =>
      requireAdmin.pipe(Effect.provide(provide(adminAuth, withMembers))),
    );

    it.effect("rejects non-admin with Forbidden", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(requireAdmin);
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(Effect.provide(provide(memberAuth, withMembers))),
    );
  });

  describe("invite (admin-gated)", () => {
    it.effect("admin can invite", () =>
      Effect.gen(function* () {
        yield* requireAdmin;
        const auth = yield* AuthContext;
        const workos = yield* WorkOSAuth;
        const result = yield* workos.sendInvitation({
          email: "new@test.com",
          organizationId: auth.organizationId,
        });

        expect(result.email).toBe("new@test.com");
      }).pipe(
        Effect.provide(
          provide(adminAuth, {
            ...withMembers,
            sendInvitation: (p: { email: string }) =>
              Effect.succeed({ id: "inv_1", email: p.email }),
          }),
        ),
      ),
    );

    it.effect("member cannot invite", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Effect.gen(function* () {
            yield* requireAdmin;
            const workos = yield* WorkOSAuth;
            yield* workos.sendInvitation({
              email: "x",
              organizationId: "org_1",
            });
          }),
        );
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(Effect.provide(provide(memberAuth, withMembers))),
    );
  });

  describe("removeMember (admin-gated)", () => {
    it.effect("admin can remove", () =>
      Effect.gen(function* () {
        yield* requireAdmin;
        const workos = yield* WorkOSAuth;
        yield* workos.deleteOrgMembership("mem_member");
      }).pipe(
        Effect.provide(
          provide(adminAuth, {
            ...withMembers,
            deleteOrgMembership: () => Effect.void,
          }),
        ),
      ),
    );

    it.effect("member cannot remove", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Effect.gen(function* () {
            yield* requireAdmin;
            const workos = yield* WorkOSAuth;
            yield* workos.deleteOrgMembership("mem_admin");
          }),
        );
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(Effect.provide(provide(memberAuth, withMembers))),
    );
  });

  describe("updateMemberRole (admin-gated)", () => {
    it.effect("admin can change role", () =>
      Effect.gen(function* () {
        yield* requireAdmin;
        const workos = yield* WorkOSAuth;
        yield* workos.updateOrgMembershipRole("mem_member", "admin");
      }).pipe(
        Effect.provide(
          provide(adminAuth, {
            ...withMembers,
            updateOrgMembershipRole: () => Effect.void,
          }),
        ),
      ),
    );

    it.effect("member cannot change role", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Effect.gen(function* () {
            yield* requireAdmin;
            const workos = yield* WorkOSAuth;
            yield* workos.updateOrgMembershipRole("mem_admin", "member");
          }),
        );
        expect(error).toBeInstanceOf(Forbidden);
      }).pipe(Effect.provide(provide(memberAuth, withMembers))),
    );
  });
});
