// ---------------------------------------------------------------------------
// @executor-js/plugin-toolkits/server
//
// The server half of the toolkits plugin. A toolkit is a named slice of the
// caller's connections, persisted as owner-scoped plugin storage:
//   - workspace toolkit  -> owner "org"  (visible to every org member)
//   - personal toolkit   -> owner "user" (visible only to its creator)
// The pluginStorage facade is already request-bound to (tenant, subject), so
// the org/user owner literal is the entire workspace-vs-personal visibility
// story. Slice 1 ships data + CRUD only — no MCP narrowing yet.
//
// React and other browser-only deps live in `./client` — never here.
// ---------------------------------------------------------------------------

import { Schema } from "effect";
import { Context, definePlugin, Effect, HttpApiBuilder } from "@executor-js/sdk/core";
import { definePluginStorageCollection, Owner, type PluginCtx } from "@executor-js/sdk";
import { addGroup, capture } from "@executor-js/api";

import {
  ToolkitForbidden,
  ToolkitNotFound,
  ToolkitsApi,
  type CreateToolkitPayload,
  type ToolkitAccess,
  type ToolkitScope,
  type ToolkitView,
  type UpdateToolkitPayload,
} from "./shared";

const ORG = Owner.make("org");
const USER = Owner.make("user");

// ---------------------------------------------------------------------------
// Storage rows (internal — not the HTTP contract). Keyed by uuid, never by a
// user-supplied value (long keyed values hit a fumadb keyed-lookup bug).
// ---------------------------------------------------------------------------

const ToolkitRow = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  inheritOrgPolicies: Schema.Boolean,
  briefing: Schema.NullOr(Schema.String),
});

const ConnectionRow = Schema.Struct({
  toolkitId: Schema.String,
  integration: Schema.String,
  connection: Schema.String,
  access: Schema.String,
  note: Schema.NullOr(Schema.String),
});

const TOOLKITS = definePluginStorageCollection("toolkits", ToolkitRow, { indexes: ["slug"] });
const CONNECTIONS = definePluginStorageCollection("connections", ConnectionRow, {
  indexes: ["toolkitId"],
});

const newId = Effect.sync(() => crypto.randomUUID());
const scopeOfOwner = (owner: Owner): ToolkitScope => (owner === ORG ? "workspace" : "personal");

// ---------------------------------------------------------------------------
// Extension — the canonical implementation. Handlers (and later the MCP
// contribution) all hit this same code path.
// ---------------------------------------------------------------------------

type ToolkitRowEntry = {
  readonly key: string;
  readonly owner: Owner;
  readonly data: typeof ToolkitRow.Type;
};

const makeToolkitsExtension = (ctx: PluginCtx) => {
  const toolkits = ctx.pluginStorage.collection(TOOLKITS);
  const connections = ctx.pluginStorage.collection(CONNECTIONS);

  const viewFromRow = (row: ToolkitRowEntry) =>
    connections.query({ where: { toolkitId: row.key } }).pipe(
      Effect.map(
        (rows): ToolkitView => ({
          id: row.key,
          slug: row.data.slug,
          name: row.data.name,
          scope: scopeOfOwner(row.owner),
          inheritOrgPolicies: row.data.inheritOrgPolicies,
          briefing: row.data.briefing,
          connections: rows.map((c) => ({
            integration: c.data.integration as ToolkitConnectionIntegration,
            connection: c.data.connection,
            access: c.data.access as ToolkitAccess,
            ...(c.data.note == null ? {} : { note: c.data.note }),
          })),
        }),
      ),
    );

  // candidate connections honoring scope: a workspace toolkit may use only
  // org connections; a personal toolkit may use org + the caller's own.
  const candidateConnections = (scope: ToolkitScope) =>
    scope === "workspace" ? ctx.connections.list({ owner: ORG }) : ctx.connections.list();

  const validate = (scope: ToolkitScope, entries: ReadonlyArray<ToolkitConnectionEntryInput>) =>
    Effect.gen(function* () {
      const allowed = yield* candidateConnections(scope);
      const pairs = new Set(allowed.map((c) => `${c.integration}/${c.name}`));
      const integrations = new Set(allowed.map((c) => c.integration));
      for (const e of entries) {
        const ok =
          e.connection === "*"
            ? integrations.has(e.integration)
            : pairs.has(`${e.integration}/${e.connection}`);
        if (!ok) {
          return yield* new ToolkitForbidden({
            reason: `connection ${e.integration}/${e.connection} is not available to a ${scope} toolkit`,
          });
        }
      }
    });

  const putConnections = (
    toolkitId: string,
    owner: Owner,
    entries: ReadonlyArray<ToolkitConnectionEntryInput>,
  ) =>
    Effect.forEach(entries, (e) =>
      newId.pipe(
        Effect.flatMap((cid) =>
          connections.put({
            key: cid,
            owner,
            data: {
              toolkitId,
              integration: e.integration,
              connection: e.connection,
              access: e.access,
              note: e.note ?? null,
            },
          }),
        ),
      ),
    );

  const create = (input: CreateToolkitPayload) =>
    Effect.gen(function* () {
      if (input.scope === "personal" && ctx.owner.subject == null) {
        return yield* new ToolkitForbidden({
          reason: "personal toolkits require a signed-in user",
        });
      }
      const owner = input.scope === "workspace" ? ORG : USER;
      const entries = input.connections ?? [];
      yield* validate(input.scope, entries);
      const id = yield* newId;
      const data = {
        slug: input.slug,
        name: input.name,
        inheritOrgPolicies: input.inheritOrgPolicies ?? true,
        briefing: input.briefing ?? null,
      };
      yield* toolkits.put({ key: id, owner, data });
      yield* putConnections(id, owner, entries);
      return yield* viewFromRow({ key: id, owner, data });
    });

  const get = (id: string) =>
    Effect.gen(function* () {
      const row = yield* toolkits.get({ key: id });
      if (row == null) return yield* new ToolkitNotFound({ id });
      return yield* viewFromRow(row);
    });

  const list = () =>
    toolkits.list().pipe(Effect.flatMap((rows) => Effect.forEach(rows, viewFromRow)));

  const update = (id: string, patch: UpdateToolkitPayload) =>
    Effect.gen(function* () {
      const row = yield* toolkits.get({ key: id });
      if (row == null) return yield* new ToolkitNotFound({ id });
      const data = {
        slug: row.data.slug,
        name: patch.name ?? row.data.name,
        inheritOrgPolicies: patch.inheritOrgPolicies ?? row.data.inheritOrgPolicies,
        briefing: patch.briefing === undefined ? row.data.briefing : patch.briefing,
      };
      yield* toolkits.put({ key: id, owner: row.owner, data });
      if (patch.connections !== undefined) {
        yield* validate(scopeOfOwner(row.owner), patch.connections);
        const existing = yield* connections.query({ where: { toolkitId: id } });
        yield* Effect.forEach(existing, (c) =>
          connections.remove({ key: c.key, owner: row.owner }),
        );
        yield* putConnections(id, row.owner, patch.connections);
      }
      return yield* viewFromRow({ key: id, owner: row.owner, data });
    });

  const remove = (id: string) =>
    Effect.gen(function* () {
      const row = yield* toolkits.get({ key: id });
      if (row == null) return yield* new ToolkitNotFound({ id });
      const existing = yield* connections.query({ where: { toolkitId: id } });
      yield* Effect.forEach(existing, (c) => connections.remove({ key: c.key, owner: row.owner }));
      yield* toolkits.remove({ key: id, owner: row.owner });
      return { removed: true };
    });

  return { create, get, list, update, remove };
};

// Local aliases so the storage/extension layer stays decoupled from the wire
// schema's branded types without re-importing them everywhere.
type ToolkitConnectionIntegration = ToolkitView["connections"][number]["integration"];
type ToolkitConnectionEntryInput = {
  readonly integration: ToolkitConnectionIntegration;
  readonly connection: string;
  readonly access: ToolkitAccess;
  readonly note?: string | undefined;
};

type ToolkitsExtension = ReturnType<typeof makeToolkitsExtension>;

export class ToolkitsExtensionService extends Context.Service<
  ToolkitsExtensionService,
  ToolkitsExtension
>()("ToolkitsExtensionService") {}

// Build handlers against the core executor API with the toolkits group added,
// so the handler layer satisfies `ApiGroup<"executor", "toolkits">` (the marker
// the host's composed API requires) — not a standalone single-group bundle.
const ExecutorApiWithToolkits = addGroup(ToolkitsApi);

const ToolkitsHandlers = HttpApiBuilder.group(ExecutorApiWithToolkits, "toolkits", (h) =>
  h
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          return yield* ext.list();
        }),
      ),
    )
    .handle("create", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          return yield* ext.create(payload);
        }),
      ),
    )
    .handle("get", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          return yield* ext.get(params.id);
        }),
      ),
    )
    .handle("update", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          return yield* ext.update(params.id, payload);
        }),
      ),
    )
    .handle("remove", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          return yield* ext.remove(params.id);
        }),
      ),
    ),
);

export const toolkitsPlugin = definePlugin(() => ({
  id: "toolkits" as const,
  packageName: "@executor-js/plugin-toolkits",
  storage: () => ({}),
  pluginStorage: { toolkits: TOOLKITS, connections: CONNECTIONS },
  extension: makeToolkitsExtension,
  routes: () => ToolkitsApi,
  handlers: () => ToolkitsHandlers,
  extensionService: ToolkitsExtensionService,
}));

export default toolkitsPlugin;
