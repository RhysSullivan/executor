import { expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import { getAuthKitUserProfile, resolveIdentityProfile } from "./identity";

test("resolveIdentityProfile uses stable user label when identity is sparse", () => {
  const subject = "user_01KH1TVHS4WJCPQG2XQJGMMJMJ";

  const profile = resolveIdentityProfile({
    identity: { subject },
    authKitProfile: null,
  });

  expect(profile.email).toBeUndefined();
  expect(profile.fullName).toBe("User GMMJMJ");
});

test("resolveIdentityProfile reads standard identity claims", () => {
  const profile = resolveIdentityProfile({
    identity: {
      subject: "user_abc123",
      email: "alex@example.com",
      given_name: "Alex",
      family_name: "Doe",
      picture: "https://cdn.example.com/alex.png",
      organization_id: "org_123",
    },
    authKitProfile: null,
  });

  expect(profile.email).toBe("alex@example.com");
  expect(profile.firstName).toBe("Alex");
  expect(profile.lastName).toBe("Doe");
  expect(profile.fullName).toBe("Alex Doe");
  expect(profile.avatarUrl).toBe("https://cdn.example.com/alex.png");
  expect(profile.hintedWorkosOrgId).toBe("org_123");
});

test("resolveIdentityProfile prefers explicit identity name", () => {
  const profile = resolveIdentityProfile({
    identity: {
      subject: "user_abc123",
      name: "Alexandra D.",
    },
    authKitProfile: null,
  });

  expect(profile.fullName).toBe("Alexandra D.");
});

test("resolveIdentityProfile reads camelCase identity claims", () => {
  const profile = resolveIdentityProfile({
    identity: {
      subject: "user_abc123",
      emailAddress: "alex@example.com",
      firstName: "Alex",
      lastName: "Doe",
      profilePictureUrl: "https://cdn.example.com/alex.png",
      organizationId: "org_123",
    },
    authKitProfile: null,
  });

  expect(profile.email).toBe("alex@example.com");
  expect(profile.firstName).toBe("Alex");
  expect(profile.lastName).toBe("Doe");
  expect(profile.fullName).toBe("Alex Doe");
  expect(profile.avatarUrl).toBe("https://cdn.example.com/alex.png");
  expect(profile.hintedWorkosOrgId).toBe("org_123");
});

test("resolveIdentityProfile reads snake_case AuthKit profile fields", () => {
  const profile = resolveIdentityProfile({
    identity: {
      subject: "workos|user_01KH1TVHS4WJCPQG2XQJGMMJMJ",
    },
    authKitProfile: {
      email: "alex@example.com",
      first_name: "Alex",
      last_name: "Doe",
      profile_picture_url: "https://cdn.example.com/alex.png",
    },
  });

  expect(profile.email).toBe("alex@example.com");
  expect(profile.firstName).toBe("Alex");
  expect(profile.lastName).toBe("Doe");
  expect(profile.fullName).toBe("Alex Doe");
  expect(profile.avatarUrl).toBe("https://cdn.example.com/alex.png");
});

test("resolveIdentityProfile reads namespaced and nested identity claims", () => {
  const profile = resolveIdentityProfile({
    identity: {
      subject: "user_abc123",
      "https://workos.com/claims/name": "Alex Doe",
      "https://workos.com/claims/picture": "https://cdn.example.com/alex.png",
      user: {
        email: "alex@example.com",
      },
      org: {
        organization_id: "org_123",
      },
    },
    authKitProfile: null,
  });

  expect(profile.email).toBe("alex@example.com");
  expect(profile.fullName).toBe("Alex Doe");
  expect(profile.avatarUrl).toBe("https://cdn.example.com/alex.png");
  expect(profile.hintedWorkosOrgId).toBe("org_123");
});

test("getAuthKitUserProfile retries with normalized user id", async () => {
  const requestedIds: string[] = [];
  const ctx = {
    runQuery: async (_fn: FunctionReference<"query", "internal">, args: { id: string }) => {
      requestedIds.push(args.id);
      return args.id === "user_01KH1TVHS4WJCPQG2XQJGMMJMJ"
        ? { id: args.id, email: "alex@example.com" }
        : null;
    },
  };

  const result = await getAuthKitUserProfile(
    ctx as never,
    "workos|user_01KH1TVHS4WJCPQG2XQJGMMJMJ",
  );

  expect(requestedIds).toEqual([
    "workos|user_01KH1TVHS4WJCPQG2XQJGMMJMJ",
    "user_01KH1TVHS4WJCPQG2XQJGMMJMJ",
  ]);
  expect(result).toEqual({
    id: "user_01KH1TVHS4WJCPQG2XQJGMMJMJ",
    email: "alex@example.com",
  });
});
