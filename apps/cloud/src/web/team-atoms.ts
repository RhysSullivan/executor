import { Atom } from "@effect-atom/atom";
import { CloudApiClient } from "./client";

export const teamMembersAtom = Atom.refreshOnWindowFocus(
  CloudApiClient.query("team", "listMembers", {
    timeToLive: "30 seconds",
  }),
);

export const teamRolesAtom = CloudApiClient.query("team", "listRoles", {
  timeToLive: "5 minutes",
});

export const inviteMember = CloudApiClient.mutation("team", "invite");

export const removeMember = CloudApiClient.mutation("team", "removeMember");

export const updateMemberRole = CloudApiClient.mutation("team", "updateMemberRole");

export const teamDomainsAtom = Atom.refreshOnWindowFocus(
  CloudApiClient.query("team", "listDomains", {
    timeToLive: "30 seconds",
  }),
);

export const getDomainVerificationLink = CloudApiClient.mutation("team", "getDomainVerificationLink");

export const deleteDomain = CloudApiClient.mutation("team", "deleteDomain");

export const updateTeamName = CloudApiClient.mutation("team", "updateTeamName");
