import { Schema } from "effect";

const permissionDomainActions = {
  organizations: ["read", "manage"],
  memberships: ["read", "write", "manage"],
  workspace: ["read", "manage"],
  sources: ["read", "write", "manage"],
  policies: ["read", "write", "manage"],
} as const;

export const PermissionDomainActions = permissionDomainActions;

export type PermissionDomain = keyof typeof permissionDomainActions;
type PermissionAction<D extends PermissionDomain> =
  (typeof permissionDomainActions)[D][number];

export type Permission = {
  [D in PermissionDomain]: `${D}:${PermissionAction<D>}`;
}[PermissionDomain];

export const PermissionValues: ReadonlyArray<Permission> = Object.entries(
  permissionDomainActions,
).flatMap(([domain, actions]) =>
  actions.map((action) => `${domain}:${action}` as Permission),
);

const permissionSet = new Set<string>(PermissionValues);

const isPermission = (value: string): value is Permission =>
  permissionSet.has(value);

export const PermissionSchema = Schema.String.pipe(
  Schema.filter(isPermission, {
    message: () => "Invalid permission",
  }),
);
