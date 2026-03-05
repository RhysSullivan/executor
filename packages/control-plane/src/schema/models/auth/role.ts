import { Schema } from "effect";

import { RoleSchema } from "./organization-membership";
import {
  PermissionSchema,
  PermissionValues,
  type Permission,
} from "./permission";

type Role = typeof RoleSchema.Type;

const readOnlyPermissions: ReadonlyArray<Permission> = PermissionValues.filter(
  (permission) => permission.endsWith(":read"),
);

const writePermissions: ReadonlyArray<Permission> = PermissionValues.filter(
  (permission) => permission.endsWith(":write"),
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
