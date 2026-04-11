import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { UserStoreError, WorkOSError } from "../auth/errors";

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {},
  HttpApiSchema.annotations({ status: 403 }),
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

const OrgMembersResponse = Schema.Struct({
  members: Schema.Array(OrgMember),
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

const membershipIdParam = HttpApiSchema.param("membershipId", Schema.String);

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

const domainIdParam = HttpApiSchema.param("domainId", Schema.String);

export { OrgMember, OrgMembersResponse };

export class OrgApi extends HttpApiGroup.make("org")
  .add(
    HttpApiEndpoint.get("listMembers")`/org/members`
      .addSuccess(OrgMembersResponse)
      .addError(WorkOSError),
  )
  .add(
    HttpApiEndpoint.get("listRoles")`/org/roles`
      .addSuccess(OrgRolesResponse)
      .addError(WorkOSError),
  )
  .add(
    HttpApiEndpoint.post("invite")`/org/invite`
      .setPayload(InviteBody)
      .addSuccess(InviteResponse)
      .addError(WorkOSError)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.del("removeMember")`/org/members/${membershipIdParam}`
      .addSuccess(RemoveResponse)
      .addError(WorkOSError)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.patch("updateMemberRole")`/org/members/${membershipIdParam}/role`
      .setPayload(UpdateRoleBody)
      .addSuccess(UpdateRoleResponse)
      .addError(WorkOSError)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("listDomains")`/org/domains`
      .addSuccess(DomainsResponse)
      .addError(WorkOSError),
  )
  .add(
    HttpApiEndpoint.post("getDomainVerificationLink")`/org/domains/verify-link`
      .addSuccess(DomainVerificationLinkResponse)
      .addError(WorkOSError)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.del("deleteDomain")`/org/domains/${domainIdParam}`
      .addSuccess(RemoveResponse)
      .addError(WorkOSError)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.patch("updateOrgName")`/org/name`
      .setPayload(UpdateOrgNameBody)
      .addSuccess(UpdateOrgNameResponse)
      .addError(WorkOSError)
      .addError(UserStoreError)
      .addError(Forbidden),
  ) {}
