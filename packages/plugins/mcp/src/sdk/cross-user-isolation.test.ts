// ---------------------------------------------------------------------------
// MCP cross-user (same-org) source isolation.
//
// Mirrors the prod executor scope stack:
//   inner = `user-org:${userId}:${orgId}`
//   outer = `${orgId}`
//
// Two users in the same org share the outer scope but have distinct inner
// scopes. A source added at user A's inner scope must NOT appear when
// user B calls `executor.sources.list()`. A source added at the shared
// org scope MUST appear for both users (that's the whole point of the
// outer scope — asserting it rules out a false positive where scope
// filtering is simply broken).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  Scope,
  ScopeId,
  collectSchemas,
  createExecutor,
  makeInMemoryBlobStore,
} from "@executor/sdk";
import { makeMemoryAdapter } from "@executor/storage-core/testing/memory";

import { mcpPlugin } from "./plugin";

// Shared memory adapter + blob store across the two executors — this is
// what makes the leak possible in the first place. Production shares a
// single Postgres across every request for an org.
const makeSharedOrgExecutors = () =>
  Effect.gen(function* () {
    const plugins = [mcpPlugin()] as const;
    const schema = collectSchemas(plugins);
    const adapter = makeMemoryAdapter({ schema });
    const blobs = makeInMemoryBlobStore();

    const ORG_ID = "org-acme";
    const USER_A = "user-alice";
    const USER_B = "user-bob";

    const orgScopeId = ScopeId.make(ORG_ID);
    const aInnerId = ScopeId.make(`user-org:${USER_A}:${ORG_ID}`);
    const bInnerId = ScopeId.make(`user-org:${USER_B}:${ORG_ID}`);

    const orgScope = new Scope({
      id: orgScopeId,
      name: "Acme",
      createdAt: new Date(),
    });

    const makeFor = (innerId: ScopeId) =>
      createExecutor({
        scopes: [
          new Scope({ id: innerId, name: "Personal", createdAt: new Date() }),
          orgScope,
        ],
        adapter,
        blobs,
        plugins,
      });

    const execA = yield* makeFor(aInnerId);
    const execB = yield* makeFor(bInnerId);

    return {
      execA,
      execB,
      aInnerId: aInnerId as string,
      bInnerId: bInnerId as string,
      orgScopeId: orgScopeId as string,
    };
  });

// Port 1 is reserved — addSource's discovery fails, but the source row
// still persists. Same trick the existing multi-scope tests use so we
// don't need an actual MCP server.
const seedSource = (
  addSource: (c: {
    readonly transport: "remote";
    readonly scope: string;
    readonly name: string;
    readonly endpoint: string;
    readonly remoteTransport: "auto";
    readonly namespace: string;
  }) => Effect.Effect<unknown, unknown>,
  args: {
    readonly scope: string;
    readonly name: string;
    readonly namespace: string;
  },
) =>
  addSource({
    transport: "remote",
    scope: args.scope,
    name: args.name,
    endpoint: `http://127.0.0.1:1/${args.namespace}`,
    remoteTransport: "auto",
    namespace: args.namespace,
  }).pipe(Effect.either);

describe("MCP cross-user isolation within the same org", () => {
  it.effect("user B does not see user A's inner-scope MCP source", () =>
    Effect.gen(function* () {
      const { execA, execB, aInnerId } = yield* makeSharedOrgExecutors();

      // User A adds a personal source at their inner scope.
      yield* seedSource(execA.mcp.addSource, {
        scope: aInnerId,
        name: "Alice Personal",
        namespace: "alice_personal",
      });

      // User B lists sources — must NOT see alice_personal.
      const bSources = yield* execB.sources.list();
      const bIds = bSources.map((s) => s.id);

      expect(bIds).not.toContain("alice_personal");
    }),
  );

  it.effect("user B DOES see org-scope sources (sanity: filter not over-broad)", () =>
    Effect.gen(function* () {
      const { execA, execB, orgScopeId } = yield* makeSharedOrgExecutors();

      // An org-scope source — shared across everyone in the org.
      yield* seedSource(execA.mcp.addSource, {
        scope: orgScopeId,
        name: "Org Shared",
        namespace: "org_shared",
      });

      const bSources = yield* execB.sources.list();
      const bIds = bSources.map((s) => s.id);

      expect(bIds).toContain("org_shared");
    }),
  );

  it.effect("A sees A's source, B sees org's, neither sees the other's inner", () =>
    Effect.gen(function* () {
      const { execA, execB, aInnerId, bInnerId, orgScopeId } =
        yield* makeSharedOrgExecutors();

      yield* seedSource(execA.mcp.addSource, {
        scope: aInnerId,
        name: "Alice Personal",
        namespace: "alice_personal",
      });
      yield* seedSource(execB.mcp.addSource, {
        scope: bInnerId,
        name: "Bob Personal",
        namespace: "bob_personal",
      });
      yield* seedSource(execA.mcp.addSource, {
        scope: orgScopeId,
        name: "Org Shared",
        namespace: "org_shared",
      });

      const aSources = yield* execA.sources.list();
      const bSources = yield* execB.sources.list();

      const aIds = aSources.map((s) => s.id);
      const bIds = bSources.map((s) => s.id);

      expect(aIds).toContain("alice_personal");
      expect(aIds).toContain("org_shared");
      expect(aIds).not.toContain("bob_personal");

      expect(bIds).toContain("bob_personal");
      expect(bIds).toContain("org_shared");
      expect(bIds).not.toContain("alice_personal");
    }),
  );
});
