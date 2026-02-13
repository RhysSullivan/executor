import { expect, test } from "bun:test";
import { resolveIdentityProfile } from "./identity";

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
