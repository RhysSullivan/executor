import { Atom } from "@effect-atom/atom";
import { CloudApiClient } from "./client";

export const orgMembersAtom = Atom.refreshOnWindowFocus(
  CloudApiClient.query("org", "listMembers", {
    timeToLive: "30 seconds",
  }),
);

export const orgRolesAtom = CloudApiClient.query("org", "listRoles", {
  timeToLive: "5 minutes",
});

export const inviteMember = CloudApiClient.mutation("org", "invite");

export const removeMember = CloudApiClient.mutation("org", "removeMember");

export const updateMemberRole = CloudApiClient.mutation("org", "updateMemberRole");

export const orgDomainsAtom = Atom.refreshOnWindowFocus(
  CloudApiClient.query("org", "listDomains", {
    timeToLive: "30 seconds",
  }),
);

export const getDomainVerificationLink = CloudApiClient.mutation("org", "getDomainVerificationLink");

export const deleteDomain = CloudApiClient.mutation("org", "deleteDomain");

export const updateOrgName = CloudApiClient.mutation("org", "updateOrgName");
