import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { UserStoreError, WorkOSError } from "./errors";
import { SessionAuth } from "./middleware";

const AuthUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

const AuthOrganization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const AuthMeResponse = Schema.Struct({
  user: AuthUser,
  organization: Schema.NullOr(AuthOrganization),
});

const AuthOrganizationSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const AuthOrganizationsResponse = Schema.Struct({
  organizations: Schema.Array(AuthOrganizationSummary),
  activeOrganizationId: Schema.NullOr(Schema.String),
});

const SwitchOrganizationBody = Schema.Struct({
  organizationId: Schema.String,
});

const CreateOrganizationBody = Schema.Struct({
  name: Schema.String,
});

const CreateOrganizationResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const AuthCallbackSearch = Schema.Struct({
  code: Schema.String,
  state: Schema.String,
});

export const AUTH_PATHS = {
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  callback: "/api/auth/callback",
  switchOrganization: "/api/auth/switch-organization",
} as const;

/** Public auth endpoints — no authentication required */
export class CloudAuthPublicApi extends HttpApiGroup.make("cloudAuthPublic")
  .add(HttpApiEndpoint.get("login")`/auth/login`)
  .add(
    HttpApiEndpoint.get("callback")`/auth/callback`
      .setUrlParams(AuthCallbackSearch)
      .addError(UserStoreError)
      .addError(WorkOSError),
  ) {}

/** Session auth endpoints — require a logged-in user, may not have an org */
export class CloudAuthApi extends HttpApiGroup.make("cloudAuth")
  .add(
    HttpApiEndpoint.get("me")`/auth/me`
      .addSuccess(AuthMeResponse)
      .addError(UserStoreError)
      .addError(WorkOSError),
  )
  .add(HttpApiEndpoint.post("logout")`/auth/logout`)
  .add(
    HttpApiEndpoint.get("organizations")`/auth/organizations`
      .addSuccess(AuthOrganizationsResponse)
      .addError(WorkOSError),
  )
  .add(
    HttpApiEndpoint.post("switchOrganization")`/auth/switch-organization`
      .setPayload(SwitchOrganizationBody)
      .addError(WorkOSError),
  )
  .add(
    HttpApiEndpoint.post("createOrganization")`/auth/create-organization`
      .setPayload(CreateOrganizationBody)
      .addSuccess(CreateOrganizationResponse)
      .addError(UserStoreError)
      .addError(WorkOSError),
  )
  .middleware(SessionAuth) {}
