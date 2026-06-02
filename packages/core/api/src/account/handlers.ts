import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import { Effect } from "effect";

import {
  AccountHttpApi,
  type CreateApiKeyBody,
  type InviteMemberBody,
  type UpdateMemberRoleBody,
  type UpdateOrgNameBody,
} from "./api";
import { AccountProvider, type AccountHeaders } from "./service";

// ---------------------------------------------------------------------------
// Shared, provider-neutral handlers for the Account API. They do nothing but
// read the request headers and delegate to the injected `AccountProvider`, so
// both cloud and self-host serve identical routes — only the service impl
// differs. The neutral errors thrown by the service map directly to their HTTP
// statuses (401/403/500) via the contract annotations.
//
// Each handler is an `Effect.fn("account.<endpoint>")` so it opens a named
// trace span / fiber. The `ctx` parameter is annotated explicitly because the
// endpoint-input type does not flow through `Effect.fn` by inference.
// ---------------------------------------------------------------------------

const requestHeaders = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (req): AccountHeaders => ({ ...req.headers }),
);

export const AccountHandlers = HttpApiBuilder.group(AccountHttpApi, "account", (handlers) =>
  handlers
    .handle(
      "me",
      Effect.fn("account.me")(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).me(headers);
      }),
    )
    .handle(
      "listApiKeys",
      Effect.fn("account.listApiKeys")(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).listApiKeys(headers);
      }),
    )
    .handle(
      "createApiKey",
      Effect.fn("account.createApiKey")(function* (ctx: { payload: typeof CreateApiKeyBody.Type }) {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).createApiKey(headers, ctx.payload.name);
      }),
    )
    .handle(
      "revokeApiKey",
      Effect.fn("account.revokeApiKey")(function* (ctx: { params: { apiKeyId: string } }) {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).revokeApiKey(headers, ctx.params.apiKeyId);
      }),
    )
    .handle(
      "listMembers",
      Effect.fn("account.listMembers")(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).listMembers(headers);
      }),
    )
    .handle(
      "listRoles",
      Effect.fn("account.listRoles")(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).listRoles(headers);
      }),
    )
    .handle(
      "inviteMember",
      Effect.fn("account.inviteMember")(function* (ctx: { payload: typeof InviteMemberBody.Type }) {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).inviteMember(headers, ctx.payload);
      }),
    )
    .handle(
      "removeMember",
      Effect.fn("account.removeMember")(function* (ctx: { params: { membershipId: string } }) {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).removeMember(headers, ctx.params.membershipId);
      }),
    )
    .handle(
      "updateMemberRole",
      Effect.fn("account.updateMemberRole")(function* (ctx: {
        params: { membershipId: string };
        payload: typeof UpdateMemberRoleBody.Type;
      }) {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).updateMemberRole(
          headers,
          ctx.params.membershipId,
          ctx.payload.roleSlug,
        );
      }),
    )
    .handle(
      "updateOrgName",
      Effect.fn("account.updateOrgName")(function* (ctx: {
        payload: typeof UpdateOrgNameBody.Type;
      }) {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).updateOrgName(headers, ctx.payload.name);
      }),
    ),
);
