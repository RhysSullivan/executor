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

const AuthCallbackSearch = Schema.Struct({
  code: Schema.String,
});

export const AUTH_PATHS = {
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  callback: "/api/auth/callback",
} as const;

/** Public auth endpoints — no authentication required */
export class CloudAuthPublicApi extends HttpApiGroup.make("cloudAuthPublic")
  .add(
    HttpApiEndpoint.get("login")`/auth/login`,
  )
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
      .addError(UserStoreError),
  )
  .add(
    HttpApiEndpoint.post("logout")`/auth/logout`,
  )
  .middleware(SessionAuth)
{}
