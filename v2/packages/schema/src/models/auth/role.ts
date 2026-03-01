import { Schema } from "effect";

import { PermissionSchema, PermissionValues, type Permission } from "./permission";

export const RoleSchema = Schema.Literal("viewer", "editor", "admin", "owner");

export type Role = typeof RoleSchema.Type;

const readOnlyPermissions: ReadonlyArray<Permission> = PermissionValues.filter(
  (permission) =>
    permission.endsWith(":read") || permission === "workspace:manage",
);

const writePermissions: ReadonlyArray<Permission> = PermissionValues.filter(
  (permission) =>
    permission.endsWith(":write") ||
    permission.endsWith(":resolve") ||
    permission.endsWith(":cancel"),
);

export const RolePermissions = {
  viewer: readOnlyPermissions,
  editor: [...readOnlyPermissions, ...writePermissions],
  admin: PermissionValues,
  owner: PermissionValues,
} as const satisfies Record<Role, ReadonlyArray<Permission>>;

export const RolePermissionsSchema = Schema.Record({
  key: RoleSchema,
  value: Schema.Array(PermissionSchema),
});

export type RolePermissions = typeof RolePermissionsSchema.Type;
