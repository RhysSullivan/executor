---
name: wrdn-effect-schema-inferred-types
description: Replace duplicated TypeScript shape declarations next to Effect Schema definitions with schema-derived types. Use when lint or review flags an interface/type alias that repeats fields already described by a nearby Schema.Struct, Schema.Union, Schema.TaggedStruct, or other Effect Schema model.
allowed-tools: Read Grep Glob Bash
---

You fix one pattern: a runtime `Schema` and a manual TypeScript type describe the same shape.

The preferred boundary is schema-first. Define the schema once, export `type X = typeof XSchema.Type` or `type X = Schema.Schema.Type<typeof XSchema>`, and make domain code consume the inferred type. This prevents drift between parsing and static types.

## Trace before changing

1. **Find the runtime schema.** Look for `Schema.Struct`, `Schema.Union`, `Schema.TaggedStruct`, `Schema.Record`, `Schema.Array`, or `Schema.decodeTo`.
2. **Find the duplicate static shape.** A nearby `interface X` or `type X = { ... }` repeats the same fields, nullability, optionality, or literals.
3. **Check export consumers.** If callers import the type, keep the exported type name stable and change only its definition.
4. **Confirm the schema is the source of truth.** If the manual type is wider/narrower than runtime parsing, decide whether the schema or consumers are wrong before replacing it.
5. **Handle recursion narrowly.** Recursive schemas may need one private recursive helper type to annotate `Schema.suspend`; keep exported domain types inferred from the schema.

## Fix shape

- Move the schema before the exported type alias when needed.
- Replace duplicated exported interfaces with aliases derived from the schema:

```ts
export const SourceSchema = Schema.Struct({
  id: SourceId,
  name: Schema.String,
  enabled: Schema.Boolean,
});

export type Source = typeof SourceSchema.Type;
```

- Use `Schema.Schema.Type<typeof XSchema>` when it reads better for non-exported or generic schemas:

```ts
type IntrospectionResult = Schema.Schema.Type<typeof IntrospectionResultModel>;
```

- If using `Schema.decodeTo`, infer the domain type from the decoded/domain schema, not from the raw transport schema.
- Do not keep a manual interface solely for documentation. Add schema annotations or comments only when they clarify behavior the schema cannot express.

## Bad

```ts
export interface StoredSource {
  readonly id: string;
  readonly url: string;
  readonly headers: readonly Header[];
}

export const StoredSourceSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  headers: Schema.Array(HeaderSchema),
});
```

## Good

```ts
export const StoredSourceSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  headers: Schema.Array(HeaderSchema),
});

export type StoredSource = typeof StoredSourceSchema.Type;
```

## Recursive schemas

Use a private helper only where TypeScript needs an annotation for self-reference:

```ts
interface TypeRefRecursive {
  readonly kind: string;
  readonly ofType: TypeRefRecursive | null;
}

const TypeRefSchema: Schema.Codec<TypeRefRecursive> = Schema.Struct({
  kind: Schema.String,
  ofType: Schema.NullOr(Schema.suspend(() => TypeRefSchema)),
});

export type TypeRef = typeof TypeRefSchema.Type;
```

The exported domain type is still schema-derived. The private helper exists only to satisfy the recursive schema definition.

## What not to report

- Domain types that intentionally do not have a runtime schema.
- Input builder types where the schema parses a different transport representation.
- Branded IDs or opaque aliases that are used by schemas but are not themselves duplicate object shapes.
- Private recursive helper types used only to type `Schema.suspend`, as long as exported consumer-facing types are inferred.

## Output requirements

When reviewing, report:

- **File and line** of the duplicated manual type.
- **Schema** that already owns the shape.
- **Why** the manual type can drift.
- **Fix**: the exact inferred alias to use.

When editing, keep exported type names stable unless every caller is updated in the same change.
