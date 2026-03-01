import type {
  UpsertOrganizationPayload,
} from "@executor-v2/management-api/organizations/api";
import type {
  UpsertWorkspacePayload,
} from "@executor-v2/management-api/workspaces/api";
import type { Organization, Workspace } from "@executor-v2/schema";

import { controlPlaneClient } from "../client";
import { globalEntity, type EntityState } from "./entity";
import { organizationsKeys, workspacesKeys } from "./keys";

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export const organizationsResult = controlPlaneClient.query(
  "organizations",
  "list",
  { reactivityKeys: organizationsKeys },
);

const sortOrganizations = (a: Organization, b: Organization): number => {
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  if (aName === bName) return a.id.localeCompare(b.id);
  return aName.localeCompare(bName);
};

export const organizationsState = globalEntity(organizationsResult, sortOrganizations);

export const upsertOrganization = controlPlaneClient.mutation("organizations", "upsert");

export const toOrganizationUpsertPayload = (input: {
  id?: Organization["id"];
  slug: string;
  name: string;
  status?: Organization["status"];
}): UpsertOrganizationPayload => ({
  ...(input.id ? { id: input.id } : {}),
  slug: input.slug,
  name: input.name,
  ...(input.status !== undefined ? { status: input.status } : {}),
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const workspacesResult = controlPlaneClient.query(
  "workspaces",
  "list",
  { reactivityKeys: workspacesKeys },
);

const sortWorkspaces = (a: Workspace, b: Workspace): number => {
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  if (aName === bName) return a.id.localeCompare(b.id);
  return aName.localeCompare(bName);
};

export const workspacesState = globalEntity(workspacesResult, sortWorkspaces);

export const upsertWorkspace = controlPlaneClient.mutation("workspaces", "upsert");

export const toWorkspaceUpsertPayload = (input: {
  id?: Workspace["id"];
  organizationId: Workspace["organizationId"];
  name: string;
}): UpsertWorkspacePayload => ({
  ...(input.id ? { id: input.id } : {}),
  organizationId: input.organizationId,
  name: input.name,
});

export type OrganizationsState = EntityState<Organization>;
export type WorkspacesState = EntityState<Workspace>;
