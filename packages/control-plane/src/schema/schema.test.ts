import { describe, expect, it } from "@effect/vitest";

import {
  PermissionValues,
  RolePermissions,
} from "./index";

describe("control-plane-schema", () => {
  it("exposes stable permission and role mappings", () => {
    expect(PermissionValues).toContain("organizations:manage");
    expect(RolePermissions.viewer).toContain("workspace:read");
    expect(RolePermissions.editor).toContain("sources:write");
    expect(RolePermissions.owner).toContain("policies:manage");
  });
});
