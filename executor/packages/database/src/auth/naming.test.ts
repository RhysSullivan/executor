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
