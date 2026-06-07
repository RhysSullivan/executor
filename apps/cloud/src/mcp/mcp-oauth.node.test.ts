// ---------------------------------------------------------------------------
// Cloud API × OAuth — real HTTP end-to-end (v2)
// ---------------------------------------------------------------------------
//
// Drives the ProtectedCloudApi through the node-pool harness against the shared
// real in-process OAuth test server. Every layer between the test and the
// plugin is real:
//
//   test → HttpApiClient → in-process webHandler → ProtectedCloudApi
//        → Core OAuthHandlers → executor.oauth.{probe,createClient,start,cancel}
//
// v2: OAuth is a credential mechanism, not an integration type. `probe`
// discovers an authorization server's metadata; `createClient` registers an
// owner-scoped OAuth app; `start` runs the flow to mint a Connection.
//
// v2: `start` runs an `authorization_code` client's flow by persisting an
// `oauth_session` and returning a `redirect` result whose `authorizationUrl`
// points at the OAuth server's authorize endpoint (the popup visits it; the
// callback later calls `complete`). The wired surface (`probe`, `createClient`,
// `start`, `cancel`) is exercised for real.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

import { Effect } from "effect";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
} from "@executor-js/sdk";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { asOrg } from "../testing/api-harness";

describe("oauth end-to-end (node pool, real OAuth server)", () => {
  it.effect(
    "probe discovers the authorization server's metadata",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const oauth = yield* serveOAuthTestServer();
          const org = `org_${crypto.randomUUID()}`;

          const probed = yield* asOrg(org, (client) =>
            client.oauth.probe({ payload: { url: oauth.issuerUrl } }),
          );

          expect(probed.authorizationUrl).toBe(oauth.authorizationEndpoint);
          expect(probed.tokenUrl).toBe(oauth.tokenEndpoint);
        }),
      ),
    30_000,
  );

  it.effect(
    "createClient registers an owner-scoped OAuth app",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const oauth = yield* serveOAuthTestServer();
          const org = `org_${crypto.randomUUID()}`;
          const slug = OAuthClientSlug.make(`client_${crypto.randomUUID().slice(0, 8)}`);

          const created = yield* asOrg(org, (client) =>
            client.oauth.createClient({
              payload: {
                owner: "org",
                slug,
                authorizationUrl: oauth.authorizationEndpoint,
                tokenUrl: oauth.tokenEndpoint,
                grant: "authorization_code",
                clientId: "test-client",
                clientSecret: "test-secret",
              },
            }),
          );
          expect(created.client).toBe(slug);
        }),
      ),
    30_000,
  );

  it.effect(
    "start returns a redirect to the authorization endpoint",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const oauth = yield* serveOAuthTestServer();
          const org = `org_${crypto.randomUUID()}`;
          const slug = OAuthClientSlug.make(`client_${crypto.randomUUID().slice(0, 8)}`);

          yield* asOrg(org, (client) =>
            client.oauth.createClient({
              payload: {
                owner: "org",
                slug,
                authorizationUrl: oauth.authorizationEndpoint,
                tokenUrl: oauth.tokenEndpoint,
                grant: "authorization_code",
                clientId: "test-client",
                clientSecret: "test-secret",
              },
            }),
          );

          const result = yield* asOrg(org, (client) =>
            client.oauth.start({
              payload: {
                client: slug,
                clientOwner: "org",
                owner: "org",
                name: ConnectionName.make("main"),
                integration: IntegrationSlug.make("some-integration"),
                template: AuthTemplateSlug.make("oauth"),
              },
            }),
          );

          expect(result).toMatchObject({
            status: "redirect",
            authorizationUrl: expect.stringContaining(oauth.authorizationEndpoint),
            state: expect.stringMatching(/.+/),
          });
        }),
      ),
    30_000,
  );

  it.effect("cancel is idempotent for an unknown session", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const cancelled = yield* asOrg(org, (client) =>
        client.oauth.cancel({
          payload: { state: OAuthState.make("oauth2_session_does_not_exist") },
        }),
      );
      expect(cancelled.cancelled).toBe(true);
    }),
  );
});
