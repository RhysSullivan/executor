// Cloud: OAuth as a credential mechanism, over the wire. `probe` discovers an
// authorization server's metadata, `createClient` registers an owner-scoped
// OAuth app, and the authorization-code flow (`start` → user consent →
// `complete`) mints a Connection — every hop real: the typed client drives the
// product API while a real OAuth authorization server runs inside the scenario
// on 127.0.0.1 (the dev server exchanges the code against it directly).
//
// Ported from apps/cloud/src/mcp/mcp-oauth.node.test.ts, extended to cover
// `complete` (the original stopped at the redirect).
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { createEmulator, connectEmulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";
import { GITHUB_EMULATOR_PORT, WORKOS_EMULATOR_PORT } from "../targets/cloud";

const api = composePluginApi([openApiHttpPlugin(), mcpHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;
const ACCESS_TOKEN_SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** Narrow a `start` result to the redirect arm, failing with what came back. */
const redirected = <R extends { status: string }>(
  result: R,
): Extract<R, { status: "redirect" }> => {
  if (result.status !== "redirect") {
    throw new Error(`oauth.start did not redirect: ${JSON.stringify(result)}`);
  }
  return result as Extract<R, { status: "redirect" }>;
};

/** Narrow an execution result to "completed", failing with what came back. */
const completed = <R extends { status: string; text: string }>(
  result: R,
): Extract<R, { status: "completed" }> => {
  if (result.status !== "completed") {
    throw new Error(`execution did not complete (status=${result.status}): ${result.text}`);
  }
  return result as Extract<R, { status: "completed" }>;
};

scenario(
  "OAuth · probe discovers an authorization server's endpoints from its issuer URL",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const oauth = yield* serveOAuthTestServer();
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);

      const probed = yield* client.oauth.probe({ payload: { url: oauth.issuerUrl } });
      expect(probed.authorizationUrl, "probe found the authorization endpoint").toBe(
        oauth.authorizationEndpoint,
      );
      expect(probed.tokenUrl, "probe found the token endpoint").toBe(oauth.tokenEndpoint);
    }),
  ),
);

scenario(
  "OAuth · a registered OAuth app is listed for its owner without leaking the secret",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const oauth = yield* serveOAuthTestServer();
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = OAuthClientSlug.make(unique("oauthc"));

      const created = yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug,
          authorizationUrl: oauth.authorizationEndpoint,
          tokenUrl: oauth.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        },
      });
      expect(created.client, "the app keeps the requested slug").toBe(slug);

      const clients = yield* client.oauth.listClients();
      const mine = clients.find((entry) => entry.slug === slug);
      expect(mine, "the registered app appears in the owner's list").toMatchObject({
        owner: "org",
        slug,
        grant: "authorization_code",
        clientId: "test-client",
      });
      expect(
        JSON.stringify(clients),
        "the client secret never appears in the list projection",
      ).not.toContain("test-secret");
    }),
  ),
);

scenario(
  "OAuth · the authorization-code flow mints a connection (start → consent → complete)",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const oauth = yield* serveOAuthTestServer();
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);

      // An integration that declares an oauth auth template — the integration
      // is what the minted connection attaches to.
      const integration = IntegrationSlug.make(unique("oauthint"));
      yield* client.openapi.addSpec({
        payload: {
          spec: {
            kind: "blob",
            value: JSON.stringify({
              openapi: "3.0.3",
              info: { title: "OAuth-protected API", version: "1.0.0" },
              paths: {
                "/me": {
                  get: {
                    operationId: "getMe",
                    tags: ["default"],
                    responses: { "200": { description: "the caller" } },
                  },
                },
              },
            }),
          },
          slug: integration,
          baseUrl: "http://127.0.0.1:59999",
          authenticationTemplate: [
            {
              slug: "oauth",
              kind: "oauth2",
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: ["read"],
            },
          ],
        },
      });

      const clientSlug = OAuthClientSlug.make(unique("oauthc"));
      yield* client.oauth.createClient({
        payload: {
          owner: "org",
          slug: clientSlug,
          authorizationUrl: oauth.authorizationEndpoint,
          tokenUrl: oauth.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        },
      });

      // start: the product persists a session and hands back the authorize URL.
      const started = redirected(
        yield* client.oauth.start({
          payload: {
            client: clientSlug,
            clientOwner: "org",
            owner: "org",
            name: ConnectionName.make("main"),
            integration,
            template: AuthTemplateSlug.make("oauth"),
          },
        }),
      );
      expect(started.authorizationUrl, "the redirect points at the authorization server").toContain(
        oauth.authorizationEndpoint,
      );

      // The user consents on the authorization server (headless here): the
      // authorize page bounces to the login form, and submitting credentials
      // redirects back to the product's callback with an authorization code.
      const authorize = yield* Effect.promise(() =>
        fetch(started.authorizationUrl, { redirect: "manual" }),
      );
      expect(authorize.status, "the authorize endpoint sends the user to log in").toBe(302);
      const consent = yield* Effect.promise(() =>
        fetch(authorize.headers.get("location") ?? "", {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
          },
        }),
      );
      expect(consent.status, "granting consent redirects back to the product").toBe(302);
      const callback = new URL(consent.headers.get("location") ?? "");
      expect(callback.searchParams.get("state"), "the callback carries the session's state").toBe(
        String(started.state),
      );
      const code = callback.searchParams.get("code");
      expect(code, "the callback carries an authorization code").not.toBeNull();

      // complete: the product exchanges the code and mints the connection.
      const connection = yield* client.oauth.complete({
        payload: { state: started.state, code: code ?? "" },
      });
      expect(connection, "the minted connection is bound to the integration").toMatchObject({
        owner: "org",
        name: "main",
        integration,
        template: "oauth",
        oauthClient: clientSlug,
      });

      const connections = yield* client.connections.list({ query: { integration } });
      expect(
        connections.map((c) => `${c.owner}/${String(c.name)}`),
        "the connection is listed for the integration",
      ).toContain("org/main");
    }),
  ),
);

scenario(
  "OAuth · cancelling an unknown session is idempotent",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);

    const cancelled = yield* client.oauth.cancel({
      payload: { state: OAuthState.make("oauth2_session_does_not_exist") },
    });
    expect(cancelled.cancelled, "cancel reports success even for an unknown session").toBe(true);
  }),
);

scenario(
  "OAuth · enterprise-managed authorization connects a WorkOS session to an MCP server",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const github = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createEmulator({
            service: "github",
            port: GITHUB_EMULATOR_PORT,
          }),
        ),
        (emulator) => Effect.promise(() => emulator.close()),
      );
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const integration = IntegrationSlug.make(unique("mcpema"));
      const connectionName = ConnectionName.make("enterprise");
      const workosUrl = `http://127.0.0.1:${WORKOS_EMULATOR_PORT}`;

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "GitHub EMA MCP",
          endpoint: `${github.url}/mcp`,
          remoteTransport: "streamable-http",
          slug: String(integration),
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });

      const probed = yield* client.oauth.probe({
        payload: { url: `${github.url}/mcp` },
      });
      expect(
        probed.supportsEnterpriseManagedAuthorization,
        "the MCP authorization server advertises the ID-JAG grant profile",
      ).toBe(true);

      const clientSlug = OAuthClientSlug.make(unique("ema_client"));
      yield* client.oauth.registerDynamic({
        payload: {
          owner: "org",
          slug: clientSlug,
          registrationEndpoint: probed.registrationEndpoint ?? `${github.url}/register`,
          authorizationUrl: probed.authorizationUrl,
          tokenUrl: probed.tokenUrl,
          resource: probed.resource ?? `${github.url}/mcp`,
          scopes: [],
          tokenEndpointAuthMethodsSupported: probed.tokenEndpointAuthMethodsSupported ?? [],
          clientName: "Executor e2e enterprise-managed auth",
          originIntegration: integration,
        },
      });

      const connection = yield* client.oauth.enterpriseManagedConnect({
        payload: {
          client: clientSlug,
          clientOwner: "org",
          owner: "org",
          name: connectionName,
          integration,
          template: AuthTemplateSlug.make("oauth2"),
          subjectTokenType: ACCESS_TOKEN_SUBJECT_TOKEN_TYPE,
          audience: github.url,
          resource: `${github.url}/mcp`,
        },
      });
      expect(
        connection,
        "the enterprise-managed exchange minted a normal OAuth connection",
      ).toMatchObject({
        owner: "org",
        name: connectionName,
        integration,
        template: "oauth2",
        oauthClient: clientSlug,
      });

      const address = `tools.${integration}.org.enterprise.get_me`;
      const tools = yield* client.tools.list({ query: { integration } });
      expect(
        tools.map((tool) => String(tool.address)),
        "the connected MCP tool is stamped on the connection",
      ).toContain(address);

      const execution = completed(
        yield* client.executions.execute({
          payload: {
            code: [`const result = await ${address}({});`, "return result;"].join("\n"),
          },
        }),
      );
      expect(execution.isError, "the MCP tool call succeeded").toBe(false);
      expect(
        execution.structured,
        "the GitHub MCP emulator resolved the WorkOS user",
      ).toMatchObject({
        result: {
          ok: true,
          data: {
            structuredContent: {
              email: identity.credentials?.email,
            },
          },
        },
      });

      const workos = yield* Effect.promise(() => connectEmulator({ baseUrl: workosUrl }));
      const workosLedger = yield* Effect.promise(() => workos.ledger.list());
      expect(
        workosLedger.some((entry) => entry.operationId === "workos.oauth.tokenExchange"),
        "the WorkOS emulator recorded the subject-token to ID-JAG exchange",
      ).toBe(true);

      const githubLedger = yield* Effect.promise(() => github.ledger.list());
      expect(
        githubLedger.some((entry) => entry.operationId === "mcp.oauth.jwtBearer"),
        "the GitHub MCP emulator recorded the ID-JAG to access-token exchange",
      ).toBe(true);
      const mcpCall = githubLedger.find(
        (entry) => entry.path === "/mcp" && entry.method === "POST",
      );
      expect(
        mcpCall?.identity.user,
        "the MCP call ran as the GitHub user derived from the WorkOS session",
      ).toMatchObject({
        login: identity.credentials?.email.split("@")[0],
        scopes: ["repo", "read:user"],
      });
    }),
  ),
);
