import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { UserStoreError, WorkOSError } from "../auth/errors";

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()(
  "Forbidden",
  {},
  { httpApiStatus: 403 },
) {}

const OrgMember = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  role: Schema.String,
  status: Schema.String,
  lastActiveAt: Schema.NullOr(Schema.String),
  isCurrentUser: Schema.Boolean,
});

const OrgMemberSeats = Schema.Struct({
  used: Schema.Number,
  granted: Schema.Number,
  unlimited: Schema.Boolean,
});

const OrgMembersResponse = Schema.Struct({
  members: Schema.Array(OrgMember),
  seats: OrgMemberSeats,
});

const OrgRole = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
});

const OrgRolesResponse = Schema.Struct({
  roles: Schema.Array(OrgRole),
});

const InviteBody = Schema.Struct({
  email: Schema.String,
  roleSlug: Schema.optional(Schema.String),
});

const InviteResponse = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
});

const MembershipParams = { membershipId: Schema.String };

const RemoveResponse = Schema.Struct({
  success: Schema.Boolean,
});

const UpdateRoleBody = Schema.Struct({
  roleSlug: Schema.String,
});

const UpdateRoleResponse = Schema.Struct({
  success: Schema.Boolean,
});

const UpdateOrgNameBody = Schema.Struct({
  name: Schema.String,
});

const UpdateOrgNameResponse = Schema.Struct({
  name: Schema.String,
});

const DomainItem = Schema.Struct({
  id: Schema.String,
  domain: Schema.String,
  state: Schema.String,
  verificationToken: Schema.optional(Schema.String),
  verificationPrefix: Schema.optional(Schema.String),
});

const DomainsResponse = Schema.Struct({
  domains: Schema.Array(DomainItem),
});

const DomainVerificationLinkResponse = Schema.Struct({
  link: Schema.String,
});

const DomainParams = { domainId: Schema.String };

export { OrgMember, OrgMembersResponse };

export class OrgApi extends HttpApiGroup.make("org")
  .add(
    HttpApiEndpoint.get("listMembers", "/org/members", {
      success: OrgMembersResponse,
      error: WorkOSError,
    }),
  )
  .add(
    HttpApiEndpoint.get("listRoles", "/org/roles", {
      success: OrgRolesResponse,
      error: WorkOSError,
    }),
  )
  .add(
    HttpApiEndpoint.post("invite", "/org/invite", {
      payload: InviteBody,
      success: InviteResponse,
      error: [WorkOSError, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeMember", "/org/members/:membershipId", {
      params: MembershipParams,
      success: RemoveResponse,
      error: [WorkOSError, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateMemberRole", "/org/members/:membershipId/role", {
      params: MembershipParams,
      payload: UpdateRoleBody,
      success: UpdateRoleResponse,
      error: [WorkOSError, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.get("listDomains", "/org/domains", {
      success: DomainsResponse,
      error: WorkOSError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getDomainVerificationLink", "/org/domains/verify-link", {
      success: DomainVerificationLinkResponse,
      error: [WorkOSError, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteDomain", "/org/domains/:domainId", {
      params: DomainParams,
      success: RemoveResponse,
      error: [WorkOSError, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateOrgName", "/org/name", {
      payload: UpdateOrgNameBody,
      success: UpdateOrgNameResponse,
      error: [WorkOSError, UserStoreError, Forbidden],
    }),
  ) {}
