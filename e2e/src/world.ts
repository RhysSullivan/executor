// The production-shaped world: a persistent, deliberately DIRTY snapshot of
// how real tenants use the product, built once per running instance and
// shared by every scenario that opts in — the opposite of the clean-slate
// `newIdentity()` model. Numbers and patterns are mined from the real
// production database (2026-06-12):
//
//   - 507 orgs, long-tail sizes: one power tenant with 27 integrations,
//     a handful with 4-9, most with 1-2.
//   - Plugin split ~50/50 openapi/mcp (graphql is a rounding error).
//   - Tool counts per integration up to 3,810; several in the 400-1,600 band.
//   - Connections split org 152 / user 178; the connection name "workspace"
//     is reused across 34 integrations; 8 duplicate-name groups; 4 cases of
//     the same name under BOTH owners in one integration.
//   - Integrations with zero connections exist (registered, never connected).
//   - Popular slugs repeat across tenants (linear_mcp ×22, github ×14, …).
//
// The world is memoized to e2e/.dev/world-<target>.json keyed by the live
// instance: a probe (does the power org still have the big integration?)
// decides reuse vs rebuild, so re-runs against the same instance keep the
// same world — state accumulates across suite runs exactly like production.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Schedule } from "effect";
import { AccountHttpApi } from "@executor-js/api";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { resendEmulatorUrl } from "./emulators";
import { joinOrg } from "./org";
import type { ApiSurface } from "./surfaces/api";
import type { Identity, Target } from "./target";

const api = composePluginApi([openApiHttpPlugin(), mcpHttpPlugin()] as const);

const API_KEY = AuthTemplateSlug.make("apiKey");
/** THE most-reused connection name in production (34 integrations). */
export const WORKSPACE = "workspace";

/** The suite's own Resend emulator (booted in cloud.boot.ts) — a real,
 *  stateful upstream that outlives any one scenario, without the shared
 *  hosted instance's accumulated state. The world is cloud-only today. */
export const RESEND_EMULATOR = resendEmulatorUrl("cloud");

// ── Manifest (persisted identities + catalog map) ───────────────────────────

interface IdentitySnapshot {
  readonly label: string;
  readonly cookie: string;
}

export interface WorldConnectionRecord {
  readonly owner: "org" | "user";
  readonly name: string;
  /** Index into the org's members for user-owned connections. */
  readonly member: number;
  /** The credential value (test data — lets later scenarios assert the wire). */
  readonly key: string;
  /** The emulator login the key was minted under — what the request ledger's
   *  `identity.user.login` reports for calls made with this credential. */
  readonly login: string;
}

export interface WorldIntegrationRecord {
  readonly slug: string;
  readonly kind: "openapi" | "mcp";
  /** Operations in the spec (0 for MCP rows registered without dialing). */
  readonly ops: number;
  /** True when baseUrl is the suite's Resend emulator — invocable from any
   *  scenario, any file, any time (local upstreams die with their scenario). */
  readonly emulator: boolean;
  readonly connections: ReadonlyArray<WorldConnectionRecord>;
}

export interface WorldOrgRecord {
  readonly company: string;
  readonly members: ReadonlyArray<IdentitySnapshot>;
  readonly integrations: ReadonlyArray<WorldIntegrationRecord>;
}

export interface WorldManifest {
  readonly version: 1;
  readonly baseUrl: string;
  readonly builtAt: string;
  /** The slug of the power org's many-operation integration. */
  readonly bigSlug: string;
  readonly bigOps: number;
  readonly orgs: ReadonlyArray<WorldOrgRecord>;
}

const WORLD_DIR = fileURLToPath(new URL("../.dev/", import.meta.url));

const manifestPath = (target: Target) => join(WORLD_DIR, `world-${target.name}.json`);

export const toIdentity = (snapshot: IdentitySnapshot): Identity => {
  const [name, value] = snapshot.cookie.split(/=(.*)/s);
  return {
    label: snapshot.label,
    headers: { cookie: snapshot.cookie },
    cookies: [{ name: name!, value: value! }],
    credentials: { email: snapshot.label, password: "emulated" },
  };
};

const toSnapshot = (identity: Identity): IdentitySnapshot => ({
  label: identity.label,
  cookie: identity.headers?.["cookie"] ?? "",
});

// ── Spec generation ──────────────────────────────────────────────────────────

/** An OpenAPI spec with `ops` GET operations — how the catalog gets DEEP.
 *  Production integrations run up to 3,810 tools; the world's big one sits in
 *  the realistic 400-1,600 band so two connections mint >1,500 tool rows. */
export const makeManyOpSpec = (title: string, ops: number): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    paths: Object.fromEntries(
      Array.from({ length: ops }, (_, index) => {
        const id = `op${String(index + 1).padStart(4, "0")}`;
        return [
          `/${id}`,
          {
            get: {
              operationId: id,
              summary: `Operation ${index + 1} of ${title}`,
              responses: { "200": { description: "ok" } },
            },
          },
        ];
      }),
    ),
  });

const BEARER_TEMPLATE = [
  {
    slug: "apiKey",
    type: "apiKey" as const,
    headers: { authorization: ["Bearer ", { type: "variable" as const, name: "token" }] },
  },
];

// ── The world's shape (mined from production) ───────────────────────────────

interface IntegrationPlan {
  readonly slug: string;
  readonly kind: "openapi" | "mcp";
  readonly ops: number;
  readonly emulator?: boolean;
  readonly connections: ReadonlyArray<{
    readonly owner: "org" | "user";
    readonly name: string;
    readonly member: number;
  }>;
}

interface OrgPlan {
  readonly company: string;
  readonly members: number;
  readonly integrations: ReadonlyArray<IntegrationPlan>;
}

const conn = (owner: "org" | "user", name: string, member = 0) => ({ owner, name, member });

/** Six companies. Slugs repeat across orgs on purpose (they do in prod), the
 *  "workspace" connection name is everywhere, big_api carries the same name
 *  under BOTH owners, and two members hold same-named personal connections on
 *  one integration. Some integrations have no connection at all. */
const WORLD_PLAN: ReadonlyArray<OrgPlan> = [
  {
    company: "Acme Capital",
    members: 3, // exactly the free plan's seat allowance
    integrations: [
      {
        slug: "big_api",
        kind: "openapi",
        ops: 800,
        connections: [conn("org", WORKSPACE), conn("user", WORKSPACE, 1)],
      },
      {
        slug: "resend_primary",
        kind: "openapi",
        ops: 0,
        emulator: true,
        connections: [conn("org", WORKSPACE)],
      },
      {
        slug: "resend_backup",
        kind: "openapi",
        ops: 0,
        emulator: true,
        connections: [conn("user", WORKSPACE, 0)],
      },
      // Same personal name held by two DIFFERENT members of one org.
      {
        slug: "exa_search_api",
        kind: "openapi",
        ops: 7,
        connections: [conn("user", WORKSPACE, 1), conn("user", WORKSPACE, 2)],
      },
      {
        slug: "github_v3_rest_api",
        kind: "openapi",
        ops: 40,
        connections: [conn("org", WORKSPACE)],
      },
      { slug: "stripe_api", kind: "openapi", ops: 25, connections: [conn("org", "main")] },
      { slug: "vercel_api", kind: "openapi", ops: 12, connections: [conn("org", WORKSPACE)] },
      { slug: "crustdata_api", kind: "openapi", ops: 25, connections: [conn("org", WORKSPACE)] },
      { slug: "census_data_api", kind: "openapi", ops: 10, connections: [] }, // registered, never connected
      { slug: "linear_mcp", kind: "mcp", ops: 0, connections: [] },
      { slug: "notion_mcp", kind: "mcp", ops: 0, connections: [] },
      { slug: "deepwiki_mcp", kind: "mcp", ops: 0, connections: [] },
    ],
  },
  {
    company: "Globex Labs",
    members: 2,
    integrations: [
      {
        slug: "resend_primary",
        kind: "openapi",
        ops: 0,
        emulator: true,
        connections: [conn("org", WORKSPACE)],
      },
      { slug: "linear_mcp", kind: "mcp", ops: 0, connections: [] },
      {
        slug: "github_v3_rest_api",
        kind: "openapi",
        ops: 40,
        connections: [conn("user", WORKSPACE, 1)],
      },
      { slug: "axiom", kind: "openapi", ops: 15, connections: [conn("org", "main")] },
    ],
  },
  {
    company: "Initech Systems",
    members: 2,
    integrations: [
      { slug: "stripe_api", kind: "openapi", ops: 25, connections: [conn("org", WORKSPACE)] },
      { slug: "cloudflare_mcp", kind: "mcp", ops: 0, connections: [] },
      {
        slug: "spotify_web_api",
        kind: "openapi",
        ops: 18,
        connections: [conn("user", "personal", 0)],
      },
    ],
  },
  {
    company: "Hooli Ventures",
    members: 1,
    integrations: [
      { slug: "exa_search_api", kind: "openapi", ops: 7, connections: [conn("org", WORKSPACE)] },
      { slug: "sentry_mcp", kind: "mcp", ops: 0, connections: [] },
    ],
  },
  {
    company: "Pied Piper",
    members: 1,
    integrations: [
      { slug: "linear_mcp", kind: "mcp", ops: 0, connections: [] },
      {
        slug: "github_v3_rest_api",
        kind: "openapi",
        ops: 40,
        connections: [conn("user", "personal", 0)],
      },
    ],
  },
  {
    company: "Umbrella Research",
    members: 1,
    integrations: [{ slug: "google", kind: "openapi", ops: 30, connections: [] }],
  },
];

// ── Build ────────────────────────────────────────────────────────────────────

// Each key is minted under a distinct login label: the emulator's request
// ledger redacts raw authorization headers but resolves the credential to
// its identity, so `identity.user.login` names WHICH key made each call —
// the cross-tenant assertion. (tryPromise + retry: the emulator can 500
// under concurrent mints.)
const mintEmulatorKey = (login: string) =>
  Effect.tryPromise({
    try: async () => {
      const client = await connectEmulator({ baseUrl: RESEND_EMULATOR });
      const credential = await client.credentials.mint({ type: "api-key", login });
      if (!credential.token) throw new Error("resend emulator key mint failed");
      return credential.token;
    },
    catch: (cause) => new Error(`emulator key mint failed: ${String(cause).slice(0, 200)}`),
  }).pipe(Effect.retry({ times: 4, schedule: Schedule.spaced("700 millis") }));

const buildOrg = (target: Target, apiSurface: ApiSurface, plan: OrgPlan) =>
  Effect.gen(function* () {
    // The founder and their teammates, through the real product flows.
    const founder = yield* target.newIdentity();
    const members: Identity[] = [founder];
    for (let i = 1; i < plan.members; i++) {
      const invitee = yield* target.newIdentity({ org: false });
      members.push(yield* joinOrg(target, founder, invitee));
    }
    const account = yield* apiSurface.client(AccountHttpApi, founder);
    yield* account.account.updateOrgName({ payload: { name: plan.company } });

    const founderClient = yield* apiSurface.client(api, founder);

    const integrations: WorldIntegrationRecord[] = [];
    for (const integration of plan.integrations) {
      const slug = IntegrationSlug.make(integration.slug);
      if (integration.kind === "mcp") {
        // Registered without dialing (discovery is deferred to connection
        // time) — production has plenty of never-connected MCP rows.
        yield* founderClient.mcp.addServer({
          payload: {
            transport: "remote",
            name: integration.slug,
            endpoint: "http://127.0.0.1:59998", // never dialed
            remoteTransport: "streamable-http",
            slug,
          },
        });
      } else if (integration.emulator) {
        // The suite's Resend emulator: a REAL upstream that outlives any
        // scenario, so world connections stay invocable from any file.
        yield* founderClient.openapi.addSpec({
          payload: {
            spec: { kind: "url", url: `${RESEND_EMULATOR}/openapi.json` },
            slug,
            baseUrl: RESEND_EMULATOR,
            authenticationTemplate: BEARER_TEMPLATE,
          },
        });
        // What real admins do for trusted tools: an org approve policy, so
        // members' (non-GET) sends run without a human pause. Production's
        // tool_policy table is full of exactly these. Policy ids are
        // `<integration>.<owner>.<connection>.<name>` (no `tools.` prefix).
        yield* founderClient.policies.create({
          payload: { owner: "org", pattern: `${integration.slug}.*`, action: "approve" },
        });
      } else {
        yield* founderClient.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: makeManyOpSpec(integration.slug, integration.ops) },
            slug,
            baseUrl: "http://127.0.0.1:59990", // catalog mass; never invoked
            authenticationTemplate: BEARER_TEMPLATE,
          },
        });
      }

      const connections: WorldConnectionRecord[] = [];
      for (const connection of integration.connections) {
        const owner = members[connection.member]!;
        const ownerClient = yield* apiSurface.client(api, owner);
        const label = `${plan.company.toLowerCase().replace(/\W+/g, "-")}-${integration.slug}-${connection.owner}-${connection.member}`;
        const key = integration.emulator ? yield* mintEmulatorKey(label) : label;
        yield* ownerClient.connections.create({
          payload: {
            owner: connection.owner,
            name: ConnectionName.make(connection.name),
            integration: slug,
            template: API_KEY,
            value: key,
          },
        });
        connections.push({ ...connection, key, login: label });
      }
      integrations.push({
        slug: integration.slug,
        kind: integration.kind,
        ops: integration.ops,
        emulator: integration.emulator ?? false,
        connections,
      });
    }

    return {
      company: plan.company,
      members: members.map(toSnapshot),
      integrations,
    } satisfies WorldOrgRecord;
  });

const buildWorld = (target: Target, apiSurface: ApiSurface) =>
  Effect.gen(function* () {
    // Companies assemble concurrently — sign-ins, invites, and addSpecs from
    // different tenants interleave, which is itself production-shaped.
    const orgs = yield* Effect.all(
      WORLD_PLAN.map((plan) => buildOrg(target, apiSurface, plan)),
      { concurrency: 3 },
    );
    const manifest: WorldManifest = {
      version: 1,
      baseUrl: target.baseUrl,
      builtAt: new Date().toISOString(),
      bigSlug: "big_api",
      bigOps: 800,
      orgs,
    };
    mkdirSync(dirname(manifestPath(target)), { recursive: true });
    writeFileSync(manifestPath(target), JSON.stringify(manifest, null, 1));
    return manifest;
  });

/** The saved manifest still matches the live instance: same base URL, and the
 *  power org's session still sees the big integration. */
const probe = (target: Target, apiSurface: ApiSurface, manifest: WorldManifest) =>
  Effect.gen(function* () {
    if (manifest.baseUrl !== target.baseUrl) return false;
    const founder = manifest.orgs[0]?.members[0];
    if (!founder) return false;
    const client = yield* apiSurface.client(api, toIdentity(founder));
    const integrations = yield* client.integrations.list();
    return integrations.map((entry) => String(entry.slug)).includes(manifest.bigSlug);
  }).pipe(Effect.catchCause(() => Effect.succeed(false)));

/**
 * The production-shaped world for this instance — loaded from the manifest
 * when it still matches the live deployment, built (once) otherwise. Cloud
 * runs files serially, so there is no build race.
 */
export const ensureProductionWorld = (
  target: Target,
  apiSurface: ApiSurface,
): Effect.Effect<WorldManifest, unknown, never> =>
  Effect.gen(function* () {
    const path = manifestPath(target);
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, "utf8")) as WorldManifest;
      if (yield* probe(target, apiSurface, saved)) return saved;
    }
    return yield* buildWorld(target, apiSurface);
  }) as Effect.Effect<WorldManifest, unknown, never>;
