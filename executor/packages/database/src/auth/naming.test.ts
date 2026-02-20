import { expect, test } from "bun:test";
import { derivePersonalNames } from "./naming";

test("derivePersonalNames ignores generated fallback full name", () => {
  const names = derivePersonalNames({
    fullName: "User GMMJMJ",
    email: "alex@example.com",
    workosUserId: "user_01KH1TVHS4WJCPQG2XQJGMMJMJ",
  });

  expect(names.organizationName).toBe("Alex's Organization");
  expect(names.workspaceName).toBe("Alex's Workspace");
});

test("derivePersonalNames prefers first name when available", () => {
  const names = derivePersonalNames({
    firstName: "Alex",
    fullName: "User GMMJMJ",
    email: "alex@example.com",
    workosUserId: "user_01KH1TVHS4WJCPQG2XQJGMMJMJ",
  });

  expect(names.organizationName).toBe("Alex's Organization");
  expect(names.workspaceName).toBe("Alex's Workspace");
});

test("derivePersonalNames ignores auth-prefixed user id full name", () => {
  const names = derivePersonalNames({
    fullName: "authkit|user_01KH1TVHS4WJCPQG2XQJGMMJMJ",
    email: "jane.doe@example.com",
    workosUserId: "authkit|user_01KH1TVHS4WJCPQG2XQJGMMJMJ",
  });

  expect(names.organizationName).toBe("Jane Doe's Organization");
  expect(names.workspaceName).toBe("Jane Doe's Workspace");
});
