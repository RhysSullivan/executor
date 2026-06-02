import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Provider-neutral Account API.
//
// This is the multiplayer "account" surface that BOTH the cloud (WorkOS) and
// self-host (Better Auth) servers implement, at the SAME paths, so the shared
// React UI (shell, api-keys page, org page) is identical for both — only the
// server-side handler implementations and the login UX differ per provider.
//
// Deliberately minimal: it covers exactly what the shared shell + pages need
// (who am I, API keys, org members). Provider-specific surfaces that only one
// product has — cloud's multi-org switcher, WorkOS domains, billing — stay in
// app-local API groups and are wired into the shell through injected slots,
// NOT into this contract. That keeps the shared typed client fully implemented
// by both servers (no half-built HttpApi layers).
// ---------------------------------------------------------------------------

// ── Neutral errors ─────────────────────────────────────────────────────────
// Each provider maps its native failures (WorkOSError, Better Auth APIError,
// storage faults) onto these at the handler boundary, so the UI handles one
// neutral shape.

export class AccountError extends Schema.TaggedErrorClass<AccountError>()(
  "AccountError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export class AccountForbidden extends Schema.TaggedErrorClass<AccountForbidden>()(
  "AccountForbidden",
  { message: Schema.optional(Schema.String) },
  { httpApiStatus: 403 },
) {}

export class AccountNoOrganization extends Schema.TaggedErrorClass<AccountNoOrganization>()(
  "AccountNoOrganization",
  {},
  { httpApiStatus: 403 },
) {}

export class AccountUnauthorized extends Schema.TaggedErrorClass<AccountUnauthorized>()(
  "AccountUnauthorized",
  {},
  { httpApiStatus: 401 },
) {}

// ── Shared shapes ────────────────────────────────────────────────────────────

export const AccountUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

export const AccountOrganization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export const AccountMeResponse = Schema.Struct({
  user: AccountUser,
  organization: Schema.NullOr(AccountOrganization),
});

export const ApiKeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Masked display value (e.g. "exk_…a1b2"). The full secret is only ever
   *  returned once, from `createApiKey`. */
  obfuscatedValue: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});

export const ApiKeysResponse = Schema.Struct({
  apiKeys: Schema.Array(ApiKeySummary),
});

export const CreateApiKeyBody = Schema.Struct({
  name: Schema.String,
});

/** Create returns the summary PLUS the one-time plaintext `value`. */
export const CreatedApiKeyResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  obfuscatedValue: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  value: Schema.String,
});

export const OrgMember = Schema.Struct({
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

/** Seat usage. Self-host (unlimited) reports `unlimited: true`; cloud reports
 *  real plan seats. Optional so providers without a seat model can omit it. */
export const OrgMemberSeats = Schema.Struct({
  used: Schema.Number,
  granted: Schema.Number,
  unlimited: Schema.Boolean,
});

export const OrgMembersResponse = Schema.Struct({
  members: Schema.Array(OrgMember),
  seats: Schema.optional(OrgMemberSeats),
});

export const OrgRole = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
});

export const OrgRolesResponse = Schema.Struct({
  roles: Schema.Array(OrgRole),
});

export const InviteMemberBody = Schema.Struct({
  email: Schema.String,
  roleSlug: Schema.optional(Schema.String),
});

export const InviteMemberResponse = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
});

export const UpdateMemberRoleBody = Schema.Struct({
  roleSlug: Schema.String,
});

export const UpdateOrgNameBody = Schema.Struct({
  name: Schema.String,
});

export const UpdateOrgNameResponse = Schema.Struct({
  name: Schema.String,
});

export const SuccessResponse = Schema.Struct({
  success: Schema.Boolean,
});

const ApiKeyParams = { apiKeyId: Schema.String };
const MembershipParams = { membershipId: Schema.String };

// ── Group ────────────────────────────────────────────────────────────────────

/**
 * The neutral account group. Mounted at `/account/*` by both servers. Auth is
 * applied by each server's own session middleware (cookie-based, same-origin),
 * so this contract carries no provider-specific auth scheme.
 */
export const AccountApi = HttpApiGroup.make("account")
  .add(
    HttpApiEndpoint.get("me", "/account/me", {
      success: AccountMeResponse,
      error: [AccountError, AccountUnauthorized],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "account.me",
        summary: "Current Account",
        description: "Returns the authenticated user and their current organization (if any).",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("listApiKeys", "/account/api-keys", {
      success: ApiKeysResponse,
      error: [AccountError, AccountUnauthorized, AccountNoOrganization],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "account.listApiKeys",
        summary: "List API Keys",
        description: "Lists the API keys for the current organization, each with a masked value.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("createApiKey", "/account/api-keys", {
      payload: CreateApiKeyBody,
      success: CreatedApiKeyResponse,
      error: [AccountError, AccountUnauthorized, AccountNoOrganization],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "account.createApiKey",
        summary: "Create API Key",
        description:
          "Creates a named API key for the current organization and returns its one-time plaintext value.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("revokeApiKey", "/account/api-keys/:apiKeyId", {
      params: ApiKeyParams,
      success: SuccessResponse,
      error: [AccountError, AccountUnauthorized, AccountNoOrganization],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "account.revokeApiKey",
        summary: "Revoke API Key",
        description: "Revokes the API key identified by the given id for the current organization.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("listMembers", "/account/members", {
      success: OrgMembersResponse,
      error: [AccountError, AccountUnauthorized, AccountNoOrganization],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "account.listMembers",
        summary: "List Members",
        description:
          "Lists the members of the current organization along with optional seat usage.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("listRoles", "/account/roles", {
      success: OrgRolesResponse,
      error: [AccountError, AccountUnauthorized, AccountNoOrganization],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "account.listRoles",
        summary: "List Roles",
        description:
          "Lists the roles available for assigning to members of the current organization.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("inviteMember", "/account/members/invite", {
      payload: InviteMemberBody,
      success: InviteMemberResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "account.inviteMember",
        summary: "Invite Member",
        description:
          "Invites a user by email to the current organization, optionally with a specific role.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("removeMember", "/account/members/:membershipId", {
      params: MembershipParams,
      success: SuccessResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "account.removeMember",
        summary: "Remove Member",
        description:
          "Removes the membership identified by the given id from the current organization.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("updateMemberRole", "/account/members/:membershipId/role", {
      params: MembershipParams,
      payload: UpdateMemberRoleBody,
      success: SuccessResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "account.updateMemberRole",
        summary: "Update Member Role",
        description: "Updates the role of the membership identified by the given id.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("updateOrgName", "/account/name", {
      payload: UpdateOrgNameBody,
      success: UpdateOrgNameResponse,
      error: [AccountError, AccountUnauthorized, AccountForbidden, AccountNoOrganization],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "account.updateOrgName",
        summary: "Update Org Name",
        description: "Updates the display name of the current organization.",
      }),
    ),
  );

/**
 * Standalone HttpApi wrapping just the account group — used to build the shared
 * `AccountApiClient` in `@executor-js/react`. Servers don't use this; they add
 * `AccountApi` to their own full API so it's served alongside the core groups.
 */
export const AccountHttpApi = HttpApi.make("executor-account").add(AccountApi);
