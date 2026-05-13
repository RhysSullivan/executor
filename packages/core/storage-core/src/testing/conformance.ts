// ---------------------------------------------------------------------------
// DBAdapter conformance suite
// ---------------------------------------------------------------------------
//
// Parameterized test suite every storage backend runs against. One suite,
// N backends — a bug can't land in sqlite and not in postgres (or vice
// versa) without a test failing somewhere.
//
// Consumers call `runAdapterConformance(name, withAdapter)` from their own
// test file, passing a setup function that provides an adapter built
// against the shared `conformanceSchema`. Every assertion below must hold
// for any backend that implements `DBAdapter`.

import { describe, it } from "@effect/vitest";
import { expect } from "@effect/vitest";
import { Data, Effect, Result } from "effect";

import type { DBAdapter } from "../adapter";
import type { DBSchema } from "../schema";

// ---------------------------------------------------------------------------
// Shared schema — exercises every column type the plugin surface uses
// ---------------------------------------------------------------------------

export const conformanceSchema: DBSchema = {
  source: {
    fields: {
      name: { type: "string", required: true },
      priority: { type: "number" },
      enabled: { type: "boolean" },
      createdAt: { type: "date" },
      metadata: { type: "json" },
    },
  },
  tag: {
    fields: {
      label: { type: "string", required: true },
    },
  },
  // Join-conformance table. `sourceId` carries a foreign key reference
  // to `source.id`, letting the shared suite exercise the `join` option
  // end-to-end (drizzle relations → query builder → nested decode).
  source_tag: {
    fields: {
      sourceId: {
        type: "string",
        required: true,
        references: { model: "source", field: "id", onDelete: "cascade" },
      },
      note: { type: "string" },
    },
  },
  // Defaults / onUpdate conformance table. Exercises the factory's
  // withApplyDefault helper: `nickname` is optional with a defaultValue,
  // `touchedAt` has an onUpdate hook. Regression coverage for two bugs
  // we hit porting better-auth's factory:
  //   (1) create: an explicit `null` for an optional field must be
  //       preserved, not overwritten by defaultValue
  //   (2) update: an explicit caller value must win over onUpdate
  with_defaults: {
    modelName: "with_defaults",
    fields: {
      name: { type: "string", required: true },
      nickname: { type: "string", required: false, defaultValue: "anon" },
      touchedAt: {
        type: "date",
        required: false,
        onUpdate: () => new Date("2099-01-01T00:00:00.000Z"),
      },
    },
  },
};

export type WithAdapter = <A, E>(
  fn: (adapter: DBAdapter) => Effect.Effect<A, E>,
) => Effect.Effect<A, E | Error>;

class TransactionRollbackTestError extends Data.TaggedError("TransactionRollbackTestError")<{}> {}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export const runAdapterConformance = (name: string, withAdapter: WithAdapter): void => {
  describe(`conformance: ${name}`, () => {
    const withDefaultsInput = (
      value: unknown,
    ): {
      readonly name: string;
      readonly nickname: string | null;
    } =>
      value as {
        readonly name: string;
        readonly nickname: string | null;
      };

    it.effect("create + findOne round-trips coerced columns", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const created = yield* adapter.create<{
            id: string;
            name: string;
            priority: number;
            enabled: boolean;
            createdAt: Date;
            metadata: Record<string, unknown>;
          }>({
            model: "source",
            data: {
              name: "github",
              priority: 10,
              enabled: true,
              createdAt: new Date("2026-04-15T00:00:00.000Z"),
              metadata: { slug: "gh", tags: ["a", "b"] },
            },
          });

          expect(created.id).toBeDefined();
          expect(created.name).toBe("github");
          expect(created.enabled).toBe(true);
          expect(created.metadata).toEqual({ slug: "gh", tags: ["a", "b"] });

          const found = yield* adapter.findOne<{
            id: string;
            name: string;
            enabled: boolean;
            createdAt: Date;
            metadata: Record<string, unknown>;
          }>({
            model: "source",
            where: [{ field: "name", value: "github" }],
          });

          expect(found).not.toBeNull();
          expect(found!.id).toBe(created.id);
          expect(found!.enabled).toBe(true);
          expect(found!.createdAt instanceof Date).toBe(true);
          expect(found!.createdAt.toISOString()).toBe("2026-04-15T00:00:00.000Z");
          expect(found!.metadata).toEqual({ slug: "gh", tags: ["a", "b"] });
        }),
      ),
    );

    it.effect("Date columns survive a write path that takes Date instances", () =>
      // Regression: pg-adapter's sql.unsafe path rejected Date instances
      // until we ISO-stringified them in encodeValue. Keep every backend
      // honest on this — a Date in should match a Date out.
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const d = new Date("2001-09-11T12:34:56.789Z");
          const row = yield* adapter.create<{
            id: string;
            name: string;
            createdAt: Date;
          }>({
            model: "source",
            data: { name: "date-test", createdAt: d },
          });
          const found = yield* adapter.findOne<{ createdAt: Date }>({
            model: "source",
            where: [{ field: "id", value: row.id }],
          });
          expect(found!.createdAt.toISOString()).toBe(d.toISOString());
        }),
      ),
    );

    it.effect("json columns round-trip nested structures", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const payload = {
            nested: { a: 1, b: [true, null, "x"] },
            arr: [{ k: "v" }],
          };
          const row = yield* adapter.create<{
            id: string;
            name: string;
            metadata: typeof payload;
          }>({
            model: "source",
            data: { name: "json-test", metadata: payload },
          });
          const found = yield* adapter.findOne<{
            metadata: typeof payload;
          }>({
            model: "source",
            where: [{ field: "id", value: row.id }],
          });
          expect(found!.metadata).toEqual(payload);
        }),
      ),
    );

    it.effect("forceAllowId preserves caller-supplied id", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          yield* adapter.create({
            model: "tag",
            forceAllowId: true,
            data: { id: "tag-fixed-1", label: "red" } as {
              label: string;
            },
          });
          const found = yield* adapter.findOne<{ id: string; label: string }>({
            model: "tag",
            where: [{ field: "id", value: "tag-fixed-1" }],
          });
          expect(found).not.toBeNull();
          expect(found!.id).toBe("tag-fixed-1");
          expect(found!.label).toBe("red");
        }),
      ),
    );

    it.effect("update mutates fields and returns the new row", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const row = yield* adapter.create<{
            id: string;
            name: string;
            priority: number;
          }>({
            model: "source",
            data: { name: "gitlab", priority: 1 },
          });
          const updated = yield* adapter.update<{
            id: string;
            priority: number;
          }>({
            model: "source",
            where: [{ field: "id", value: row.id }],
            update: { priority: 99 },
          });
          expect(updated).not.toBeNull();
          expect(updated!.priority).toBe(99);
        }),
      ),
    );

    it.effect("delete + count reflect removals", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          yield* adapter.createMany({
            model: "tag",
            data: [{ label: "a" }, { label: "b" }, { label: "c" }],
          });
          expect(yield* adapter.count({ model: "tag" })).toBe(3);

          yield* adapter.delete({
            model: "tag",
            where: [{ field: "label", value: "b" }],
          });
          expect(yield* adapter.count({ model: "tag" })).toBe(2);

          const removed = yield* adapter.deleteMany({
            model: "tag",
            where: [
              // Both clauses marked OR so split-group bucketing produces
              // a pure disjunction (andGroup empty, orGroup=[a,c]). Under
              // upstream drizzle semantics `(label=a AND label=c)` would
              // match nothing; we want a union.
              { field: "label", value: "a", connector: "OR" },
              { field: "label", value: "c", connector: "OR" },
            ],
          });
          expect(removed).toBe(2);
          expect(yield* adapter.count({ model: "tag" })).toBe(0);
        }),
      ),
    );

    it.effect("createMany bulk-inserts small batches in order", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const rows = yield* adapter.createMany<{
            id: string;
            label: string;
          }>({
            model: "tag",
            data: [{ label: "one" }, { label: "two" }, { label: "three" }],
          });
          expect(rows).toHaveLength(3);
          expect(rows.map((r) => r.label)).toEqual(["one", "two", "three"]);
          expect(yield* adapter.count({ model: "tag" })).toBe(3);
        }),
      ),
    );

    it.effect("createMany handles batches larger than a chunk window", () =>
      // Regression: storage-file used to do one Effect.gen per row and
      // hung on 1000+ rows. The fix was chunked sql.insert at 500. Keep
      // every backend honest on large inputs.
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const N = 1200;
          const data = Array.from({ length: N }, (_, i) => ({
            label: `bulk-${i}`,
          }));
          const rows = yield* adapter.createMany<{
            id: string;
            label: string;
          }>({ model: "tag", data });
          expect(rows).toHaveLength(N);
          expect(yield* adapter.count({ model: "tag" })).toBe(N);
        }),
      ),
    );

    it.effect("findMany supports sort + limit + offset", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          yield* adapter.createMany({
            model: "source",
            data: [
              { name: "a", priority: 3 },
              { name: "b", priority: 1 },
              { name: "c", priority: 2 },
            ],
          });
          const asc = yield* adapter.findMany<{
            name: string;
            priority: number;
          }>({
            model: "source",
            sortBy: { field: "priority", direction: "asc" },
          });
          expect(asc.map((r) => r.name)).toEqual(["b", "c", "a"]);

          const firstDesc = yield* adapter.findMany<{ name: string }>({
            model: "source",
            sortBy: { field: "priority", direction: "desc" },
            limit: 1,
          });
          expect(firstDesc.map((r) => r.name)).toEqual(["a"]);

          const offset1 = yield* adapter.findMany<{ name: string }>({
            model: "source",
            sortBy: { field: "priority", direction: "asc" },
            offset: 1,
          });
          expect(offset1.map((r) => r.name)).toEqual(["c", "a"]);
        }),
      ),
    );

    it.effect("where operators: contains, starts_with, ends_with, gte", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          yield* adapter.createMany({
            model: "source",
            data: [
              { name: "github-main", priority: 1 },
              { name: "github-edge", priority: 5 },
              { name: "gitlab", priority: 10 },
            ],
          });

          const contains = yield* adapter.findMany<{ name: string }>({
            model: "source",
            where: [{ field: "name", value: "git", operator: "contains" }],
          });
          expect(contains).toHaveLength(3);

          const starts = yield* adapter.findMany<{ name: string }>({
            model: "source",
            where: [{ field: "name", value: "github", operator: "starts_with" }],
          });
          expect(starts).toHaveLength(2);

          const ends = yield* adapter.findMany<{ name: string }>({
            model: "source",
            where: [{ field: "name", value: "lab", operator: "ends_with" }],
          });
          expect(ends).toHaveLength(1);
          expect(ends[0]!.name).toBe("gitlab");

          const highPriority = yield* adapter.findMany<{ name: string }>({
            model: "source",
            where: [{ field: "priority", value: 5, operator: "gte" }],
          });
          expect(highPriority.map((r) => r.name).sort()).toEqual(["github-edge", "gitlab"]);
        }),
      ),
    );

    it.effect("where operator: in / not_in", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          yield* adapter.createMany({
            model: "tag",
            data: [{ label: "a" }, { label: "b" }, { label: "c" }],
          });
          const some = yield* adapter.findMany<{ label: string }>({
            model: "tag",
            where: [{ field: "label", value: ["a", "c"], operator: "in" }],
          });
          expect(some.map((r) => r.label).sort()).toEqual(["a", "c"]);

          const none = yield* adapter.findMany<{ label: string }>({
            model: "tag",
            where: [{ field: "label", value: ["a", "c"], operator: "not_in" }],
          });
          expect(none.map((r) => r.label)).toEqual(["b"]);
        }),
      ),
    );

    it.effect("insensitive string comparison", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          yield* adapter.create({ model: "tag", data: { label: "RED" } });
          const hit = yield* adapter.findOne<{ label: string }>({
            model: "tag",
            where: [{ field: "label", value: "red", mode: "insensitive" }],
          });
          expect(hit).not.toBeNull();
          expect(hit!.label).toBe("RED");
        }),
      ),
    );

    it.effect("where operator: in / not_in honors insensitive mode", () =>
      // Regression: drizzle adapter collapsed insensitive in/not_in to
      // sensitive SQL, so a query with mixed-case values silently missed
      // rows. Fix emits LOWER(col) IN (lower(v1), lower(v2)).
      withAdapter((adapter) =>
        Effect.gen(function* () {
          yield* adapter.createMany({
            model: "tag",
            data: [{ label: "RED" }, { label: "Green" }, { label: "blue" }],
          });

          const hitIn = yield* adapter.findMany<{ label: string }>({
            model: "tag",
            where: [
              {
                field: "label",
                value: ["red", "GREEN"],
                operator: "in",
                mode: "insensitive",
              },
            ],
          });
          expect(hitIn.map((r) => r.label).sort()).toEqual(["Green", "RED"]);

          const hitNotIn = yield* adapter.findMany<{ label: string }>({
            model: "tag",
            where: [
              {
                field: "label",
                value: ["red", "GREEN"],
                operator: "not_in",
                mode: "insensitive",
              },
            ],
          });
          expect(hitNotIn.map((r) => r.label)).toEqual(["blue"]);
        }),
      ),
    );

    it.effect("create preserves explicit null over defaultValue on optional fields", () =>
      // Regression: the vendored withApplyDefault overwrote an explicit
      // `null` with `defaultValue` even for optional fields. Upstream only
      // applies the default when `value === undefined` OR the field is
      // required AND the caller passed null.
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const row = yield* adapter.create<{
            id: string;
            name: string;
            nickname: string | null;
          }>({
            model: "with_defaults",
            data: { name: "explicit-null", nickname: null },
          });
          expect(row.nickname).toBeNull();

          const defaulted = yield* adapter.create<{
            id: string;
            name: string;
            nickname: string | null;
          }>({
            model: "with_defaults",
            data: withDefaultsInput({ name: "omitted", nickname: undefined }),
          });
          expect(defaulted.nickname).toBe("anon");
        }),
      ),
    );

    it.effect("update preserves explicit value over onUpdate hook", () =>
      // Regression: vendored withApplyDefault unconditionally ran
      // `field.onUpdate()` on update, clobbering any explicit caller
      // value. Upstream only runs onUpdate when the caller didn't pass
      // the field (value === undefined).
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const row = yield* adapter.create<{ id: string; name: string }>({
            model: "with_defaults",
            data: { name: "caller-wins" },
          });
          const explicitDate = new Date("2024-06-15T12:00:00.000Z");
          const updated = yield* adapter.update<{
            id: string;
            touchedAt: Date;
          }>({
            model: "with_defaults",
            where: [{ field: "id", value: row.id }],
            update: { touchedAt: explicitDate },
          });
          expect(updated).not.toBeNull();
          expect(updated!.touchedAt.toISOString()).toBe(explicitDate.toISOString());
          // Sanity: omitting touchedAt should trigger onUpdate.
          const hookDriven = yield* adapter.update<{
            id: string;
            name: string;
            touchedAt: Date;
          }>({
            model: "with_defaults",
            where: [{ field: "id", value: row.id }],
            update: { name: "rename" },
          });
          expect(hookDriven).not.toBeNull();
          expect(hookDriven!.touchedAt.toISOString()).toBe("2099-01-01T00:00:00.000Z");
        }),
      ),
    );

    it.effect("transaction rolls back on failure", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const before = yield* adapter.count({ model: "tag" });
          const result = yield* adapter
            .transaction((trx) =>
              Effect.gen(function* () {
                yield* trx.create({ model: "tag", data: { label: "tx1" } });
                yield* trx.create({ model: "tag", data: { label: "tx2" } });
                return yield* new TransactionRollbackTestError();
              }),
            )
            .pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          const after = yield* adapter.count({ model: "tag" });
          expect(after).toBe(before);
        }),
      ),
    );

    it.effect("transaction commits on success", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          yield* adapter.transaction((trx) =>
            Effect.gen(function* () {
              yield* trx.create({ model: "tag", data: { label: "ok1" } });
              yield* trx.create({ model: "tag", data: { label: "ok2" } });
            }),
          );
          expect(yield* adapter.count({ model: "tag" })).toBe(2);
        }),
      ),
    );

    it.effect("where: mixed AND/OR grouping follows upstream split-group semantics", () =>
      // Locks in better-auth drizzle adapter's `convertWhereClause`
      // semantics: AND-connector clauses and OR-connector clauses split
      // into two groups, recombined as `(AND…) AND (OR…)`. For
      // [{priority=1, AND}, {priority=10, OR}, {enabled=true, AND}],
      // that's `(priority=1 AND enabled=true) AND (priority=10)` which
      // can never match a single row — while a left-to-right fold
      // would give `((priority=1 OR priority=10) AND enabled=true)`
      // and return two rows. We assert the upstream reading.
      withAdapter((adapter) =>
        Effect.gen(function* () {
          yield* adapter.createMany({
            model: "source",
            data: [
              { name: "lhs", priority: 1, enabled: true },
              { name: "rhs", priority: 10, enabled: true },
              { name: "off", priority: 1, enabled: false },
            ],
          });
          const rows = yield* adapter.findMany<{ name: string }>({
            model: "source",
            where: [
              { field: "priority", value: 1, connector: "AND" },
              { field: "priority", value: 10, connector: "OR" },
              { field: "enabled", value: true, connector: "AND" },
            ],
          });
          // Upstream split-group: (priority=1 AND enabled=true) AND
          // (priority=10). `lhs` has priority=1 (fails the OR group's
          // priority=10 check) and `rhs` has priority=10 (fails the
          // AND group's priority=1 check) — both reject.
          expect(rows.map((r) => r.name)).toEqual([]);

          // Sanity: a pure disjunction still works.
          const both = yield* adapter.findMany<{ name: string }>({
            model: "source",
            where: [
              { field: "priority", value: 1, connector: "OR" },
              { field: "priority", value: 10, connector: "OR" },
            ],
            sortBy: { field: "name", direction: "asc" },
          });
          expect(both.map((r) => r.name)).toEqual(["lhs", "off", "rhs"]);
        }),
      ),
    );

    it.effect("findMany resolves join: source → source_tag (one-to-many)", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const src = yield* adapter.create<{ id: string; name: string }>({
            model: "source",
            data: { name: "joined-source" },
          });
          yield* adapter.createMany({
            model: "source_tag",
            data: [
              { sourceId: src.id, note: "first" },
              { sourceId: src.id, note: "second" },
            ],
          });

          const many = yield* adapter.findMany<{
            id: string;
            name: string;
            source_tag: ReadonlyArray<{ note: string; sourceId: string }>;
          }>({
            model: "source",
            where: [{ field: "id", value: src.id }],
            join: { source_tag: true },
          });
          expect(many).toHaveLength(1);
          const parent = many[0]!;
          expect(parent.name).toBe("joined-source");
          expect(Array.isArray(parent.source_tag)).toBe(true);
          expect(parent.source_tag).toHaveLength(2);
          expect(parent.source_tag.map((t) => t.note).sort()).toEqual(["first", "second"]);
        }),
      ),
    );

    it.effect("findOne resolves join: source_tag → source (one-to-one)", () =>
      withAdapter((adapter) =>
        Effect.gen(function* () {
          const src = yield* adapter.create<{ id: string; name: string }>({
            model: "source",
            data: { name: "owner" },
          });
          const child = yield* adapter.create<{
            id: string;
            sourceId: string;
            note: string;
          }>({
            model: "source_tag",
            data: { sourceId: src.id, note: "only" },
          });

          const found = yield* adapter.findOne<{
            id: string;
            note: string;
            sourceId: string;
            source: { id: string; name: string } | null;
          }>({
            model: "source_tag",
            where: [{ field: "id", value: child.id }],
            join: { source: true },
          });
          expect(found).not.toBeNull();
          expect(found!.note).toBe("only");
          expect(found!.source).not.toBeNull();
          expect(found!.source!.id).toBe(src.id);
          expect(found!.source!.name).toBe("owner");
        }),
      ),
    );

    it.effect("nested writes inside a transaction see the tx state", () =>
      // Regression / forward test: apps/cloud deadlocked because nested
      // writes routed around the active tx connection. When ctx.transaction
      // becomes real (FiberRef-threaded), this must still pass — reads and
      // writes inside the callback must observe in-flight tx state.
      withAdapter((adapter) =>
        Effect.gen(function* () {
          yield* adapter.transaction((trx) =>
            Effect.gen(function* () {
              yield* trx.create({ model: "tag", data: { label: "inside" } });
              const c = yield* trx.count({ model: "tag" });
              expect(c).toBe(1);
            }),
          );
          expect(yield* adapter.count({ model: "tag" })).toBe(1);
        }),
      ),
    );
  });
};
