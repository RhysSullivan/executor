// Cloud-only: scenarios over the production-shaped WORLD (src/world.ts) — a
// persistent six-company snapshot with prod-mined mess: an 800-operation
// integration, the "workspace" connection name reused everywhere (including
// under BOTH owners of one integration, and by two different members of the
// same org), never-connected integrations, and repeated slugs across tenants.
//
// Unlike every other file, these tests do NOT start from a clean slate: the
// world is built once per instance and reused across suite runs (state
// accumulates, like production). The first run pays the build; later runs
// probe and attach.
//
//   1. The whole world invokes AT ONCE: every company's members fire real
//      executions concurrently through their own credentials against a live
//      upstream (the suite's Resend emulator), and the emulator's request
//      ledger proves each call carried ITS OWN tenant's key — cross-tenant
//      and cross-user isolation under genuine concurrent load, not in a
//      vacuum.
//   2. The 800-operation catalog stays usable and correctly partitioned:
//      tool listings under same-named org/user connections split exactly,
//      and invocation through the dense catalog still routes.
//   3. The world keeps moving while people work: one company onboards a new
//      teammate and adds an integration WHILE other tenants are mid-flight
//      with executions — growth under load changes nothing for anyone else.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { AccountHttpApi } from "@executor-js/api";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { joinOrg } from "../src/org";
import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";
import {
  ensureProductionWorld,
  makeManyOpSpec,
  RESEND_EMULATOR,
  toIdentity,
  WORKSPACE,
} from "../src/world";

const api = composePluginApi([openApiHttpPlugin(), mcpHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const completed = <R extends { status: string; text: string }>(
  execution: R,
): Extract<R, { status: "completed" }> => {
  if (execution.status !== "completed") {
    throw new Error(`execution did not complete (status=${execution.status}): ${execution.text}`);
  }
  return execution as Extract<R, { status: "completed" }>;
};

/** The send-email tool address for this owner+connection, resolved from the
 *  live tool listing (addresses derive from the spec's operation ids — resolve,
 *  don't guess). */
const sendAddress = (
  client: Client,
  slug: string,
  owner: string,
  connection: string,
): Effect.Effect<string, unknown, never> =>
  Effect.gen(function* () {
    const tools = yield* client.tools.list({ query: { integration: IntegrationSlug.make(slug) } });
    const prefix = `tools.${slug}.${owner}.${connection}.`;
    const address = tools
      .map((tool) => String(tool.address))
      .find((candidate) => candidate.startsWith(prefix) && /emails?\.send$/.test(candidate));
    if (!address) {
      throw new Error(`no send tool under ${prefix} (got ${tools.length} tools)`);
    }
    return address;
  }) as Effect.Effect<string, unknown, never>;

/** Send one email through `slug`'s send tool as this client; the subject is
 *  the correlation key for the emulator's request ledger. */
const sendEmail = (client: Client, address: string, subject: string) =>
  Effect.gen(function* () {
    const execution = completed(
      yield* client.executions.execute({
        payload: {
          code: [
            `const result = await ${address}({`,
            `  body: { from: "team@example.com", to: "world@example.com",`,
            `          subject: ${JSON.stringify(subject)}, html: "<p>world</p>" },`,
            `});`,
            "return result;",
          ].join("\n"),
        },
      }),
    );
    expect(execution.isError, `send via ${address} completed: ${execution.text}`).toBe(false);
    return execution;
  });

scenario(
  "World · every company invokes at once and each call carries its own tenant's credential",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const world = yield* ensureProductionWorld(target, apiSurface);

    // Every emulator-backed connection in the world, across all companies:
    // Acme's org workspace, Acme's founder-personal backup, Globex's org one.
    const sends: Array<{
      readonly company: string;
      readonly subject: string;
      readonly login: string;
      readonly run: Effect.Effect<unknown, unknown, never>;
    }> = [];
    for (const org of world.orgs) {
      for (const integration of org.integrations) {
        if (!integration.emulator) continue;
        for (const connection of integration.connections) {
          const member = toIdentity(org.members[connection.member]!);
          const client = yield* apiSurface.client(api, member);
          const address = yield* sendAddress(
            client,
            integration.slug,
            connection.owner,
            connection.name,
          );
          const subject = `world-${org.company.split(" ")[0]}-${connection.owner}-${randomBytes(4).toString("hex")}`;
          sends.push({
            company: org.company,
            subject,
            login: connection.login,
            run: sendEmail(client, address, subject) as Effect.Effect<unknown, unknown, never>,
          });
        }
      }
    }
    expect(
      sends.length,
      "the world has several invocable emulator connections across companies",
    ).toBeGreaterThanOrEqual(3);

    // ALL tenants fire at once — the production picture (multiple orgs
    // mid-execution in the same window), not sequential per-tenant tests.
    yield* Effect.all(
      sends.map((send) => send.run),
      { concurrency: "unbounded" },
    );

    // The emulator's ledger is ground truth: it resolves each request's
    // bearer to the identity the key was minted under (raw auth headers are
    // redacted), so the login proves each company's call carried exactly the
    // credential of the connection it went through.
    const emulator = yield* Effect.promise(() => connectEmulator({ baseUrl: RESEND_EMULATOR }));
    const entries = yield* Effect.promise(() => emulator.ledger.list());
    for (const send of sends) {
      const entry = entries.find((candidate) =>
        JSON.stringify(candidate.request.body ?? "").includes(send.subject),
      );
      expect(entry, `${send.company}'s call (${send.subject}) reached the upstream`).toBeDefined();
      const identity = (entry as { identity?: { user?: { login?: string } } }).identity;
      expect(identity?.user?.login, `${send.company}'s call carried its own credential`).toBe(
        send.login,
      );
    }
  }),
);

scenario(
  "World · the 800-operation catalog partitions exactly between same-named org and personal connections",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const world = yield* ensureProductionWorld(target, apiSurface);

    const acme = world.orgs.find((org) => org.company === "Acme Capital")!;
    const founder = toIdentity(acme.members[0]!);
    const teammate = toIdentity(acme.members[1]!);
    const founderClient = yield* apiSurface.client(api, founder);
    const teammateClient = yield* apiSurface.client(api, teammate);

    // big_api carries the SAME connection name under both owners: the org's
    // "workspace" and the teammate's personal "workspace". Production has
    // exactly this shape (4 cases live).
    const slug = IntegrationSlug.make(world.bigSlug);
    const founderTools = yield* founderClient.tools.list({ query: { integration: slug } });
    const teammateTools = yield* teammateClient.tools.list({ query: { integration: slug } });

    const ownersOf = (tools: ReadonlyArray<{ address: unknown }>) => {
      const counts = new Map<string, number>();
      for (const tool of tools) {
        const owner = String(tool.address).split(".")[2] ?? "?";
        counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }
      return counts;
    };

    // The founder sees the org's 800; the teammate sees the org's 800 PLUS
    // their personal 800 under the same connection name — and nobody else's.
    expect(
      ownersOf(founderTools).get("org"),
      "the org workspace connection minted every operation",
    ).toBe(world.bigOps);
    expect(
      ownersOf(founderTools).get("user"),
      "the founder holds no personal big_api connection — no user tools leak to them",
    ).toBeUndefined();
    expect(ownersOf(teammateTools).get("org"), "the teammate shares the org's tools").toBe(
      world.bigOps,
    );
    expect(
      ownersOf(teammateTools).get("user"),
      "the teammate's same-named personal connection minted its own full set",
    ).toBe(world.bigOps);

    // Addressing stays exact in the dense catalog: the very last operation
    // resolves through BOTH same-named connections without cross-talk.
    const last = `op${String(world.bigOps).padStart(4, "0")}`;
    expect(
      teammateTools.map((tool) => String(tool.address)),
      "the deepest operation exists under both owners",
    ).toEqual(
      expect.arrayContaining([
        `tools.${slug}.org.${WORKSPACE}.${last}.getOperation`,
        `tools.${slug}.user.${WORKSPACE}.${last}.getOperation`,
      ]),
    );
  }),
);

scenario(
  "World · a company grows (new member, new integration) while other tenants are mid-execution",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const world = yield* ensureProductionWorld(target, apiSurface);

    const acme = world.orgs.find((org) => org.company === "Acme Capital")!;
    // Growth happens at a one-person company — the world persists across
    // runs, so the journey must fit the free plan's seats and give the seat
    // back at the end (offboarding — itself a real product flow), or the
    // next run's invite gets refused.
    const hooli = world.orgs.find((org) => org.company === "Hooli Ventures")!;

    // Background load: Acme members hammer real executions through the
    // emulator connection for the duration of the growth steps.
    const acmeFounder = toIdentity(acme.members[0]!);
    const acmeClient = yield* apiSurface.client(api, acmeFounder);
    const emulated = acme.integrations.find(
      (integration) =>
        integration.emulator &&
        integration.connections.some((connection) => connection.owner === "org"),
    )!;
    const orgConnection = emulated.connections.find((connection) => connection.owner === "org")!;
    const address = yield* sendAddress(acmeClient, emulated.slug, "org", orgConnection.name);
    const load = Effect.all(
      Array.from({ length: 6 }, (_, index) =>
        sendEmail(acmeClient, address, `world-load-${index}-${randomBytes(3).toString("hex")}`),
      ),
      { concurrency: "unbounded" },
    );

    // Growth, concurrently with the load: Hooli hires a teammate (real
    // invite → accept) and the hire registers an integration + connection.
    const hooliFounder = toIdentity(hooli.members[0]!);
    const newSlug = IntegrationSlug.make(`growth_${randomBytes(4).toString("hex")}`);
    const growth = Effect.gen(function* () {
      const hire = yield* joinOrg(target, hooliFounder, yield* target.newIdentity({ org: false }));
      const hireClient = yield* apiSurface.client(api, hire);
      yield* hireClient.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: makeManyOpSpec(newSlug, 30) },
          slug: newSlug,
          baseUrl: "http://127.0.0.1:59990",
          authenticationTemplate: [
            {
              slug: "apiKey",
              type: "apiKey",
              headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
            },
          ],
        },
      });
      yield* hireClient.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make(WORKSPACE),
          integration: newSlug,
          template: AuthTemplateSlug.make("apiKey"),
          value: "growth-key",
        },
      });
      return hire;
    });

    // The world persists across runs: give the seat and catalog row back at
    // the end (real offboarding), even when an assertion fails mid-test.
    const founderAccount = yield* apiSurface.client(AccountHttpApi, hooliFounder);
    const founderApi = yield* apiSurface.client(api, hooliFounder);
    yield* Effect.gen(function* () {
      const [, hire] = yield* Effect.all([load, growth], { concurrency: "unbounded" });

      // The new hire's workspace works…
      const hireClient = yield* apiSurface.client(api, hire);
      const hireTools = yield* hireClient.tools.list({ query: { integration: newSlug } });
      expect(hireTools.length, "the integration added mid-load minted its full tool set").toBe(30);

      // …and the growth was invisible to the OTHER tenant: Acme never sees
      // Hooli's new integration, and Acme's own catalog is unchanged.
      const acmeIntegrations = yield* acmeClient.integrations.list();
      expect(
        acmeIntegrations.map((entry) => String(entry.slug)),
        "another tenant's mid-load growth never appears in Acme's catalog",
      ).not.toContain(String(newSlug));
      const expectedAcme = new Set(acme.integrations.map((integration) => integration.slug));
      for (const slug of expectedAcme) {
        expect(
          acmeIntegrations.map((entry) => String(entry.slug)),
          `Acme's ${slug} survived the concurrent window`,
        ).toContain(slug);
      }

      // Offboarding closes the loop: the founder removes the hire, and the
      // hire's session loses the workspace.
      const roster = yield* founderAccount.account.listMembers();
      const hireRow = roster.members.find((member) => member.email === hire.label);
      expect(hireRow, "the hire shows on the members page").toBeDefined();
      yield* founderAccount.account.removeMember({
        params: { membershipId: hireRow!.id },
      });
      const after = yield* founderAccount.account.listMembers();
      expect(
        after.members.map((member) => member.email),
        "the removed hire is gone from the roster",
      ).not.toContain(hire.label);
    }).pipe(
      // Belt-and-braces: drop the growth integration even on failure so the
      // persistent world stays at its steady-state shape.
      Effect.ensuring(
        founderApi.integrations.remove({ params: { slug: newSlug } }).pipe(Effect.ignore),
      ),
    );
  }),
);
