---
name: effect-source-of-truth
description: Ground-truth reference for writing Effect in this repo. Use whenever writing, reviewing, or migrating Effect or Schema code — services, layers, schemas, tagged errors, runtimes, HTTP. This repo runs Effect 4 / effect-smol (beta), where most idioms differ from Effect 2/3, so verify against the vendored source instead of memory.
---

# Effect: source of truth

This repo runs **Effect 4 / effect-smol** (`4.0.0-beta.*`), not Effect 3. Most APIs differ from older Effect examples, blog posts, and model memory. Guessing from memory is the most common way to introduce subtly-wrong Effect code here.

## Do not answer from memory

1. The current Effect source is vendored at **`.reference/effect-smol`**. Search it (rg/Read) for exact APIs, signatures, examples, and tests before writing or reviewing Effect code.
2. Read nearby in-repo code for local house style before introducing a new pattern.
3. Prefer answers backed by a specific source file or a nearby in-repo example over recollection.

Concrete v4 differences already hit in this repo:

- `class Service extends Context.Service<Service, Interface>()("@scope/Name") {}` — not `Context.Tag` / `Effect.Service`. A service tag is **directly yieldable** (`yield* Service`); there is no `.asEffect()`.
- Submodule imports: `effect/unstable/http`, `effect/unstable/httpapi`, `effect/unstable/observability`.
- `effect`'s structural cause: inspect `cause.reasons` (no `Cause.failures` / `Cause.defects`).
- `References.CurrentLogAnnotations` is a `Record` (iterate with `Object.entries`), not a `Map`.

## Conventions are enforced — read the rule's `Skill:` pointer

The custom oxlint plugin (`scripts/oxlint-plugin-executor/`) enforces the house style as CI errors (`--deny-warnings`). When a lint error ends with `Skill: <name>`, read that skill for the _why_ and the fix. Highlights:

- Trace public service methods with `Effect.fn("Domain.method")`; `Effect.fnUntraced` for internal helpers; `Effect.gen` for inline composition.
- Model errors with `Schema.TaggedErrorClass` and raise them as `yield* new MyError({...})` — never `Effect.fail(new MyError())`, never `Data.TaggedError` in public/wire types.
- No `Schema.Class`, no `switch`, no `try`/`catch`/`throw`, no raw `fetch`, no `JSON.parse`, no `Effect.die`/`orDie` for expected failures in domain code. Prefer Effect platform services (`FileSystem`, `HttpClient`).

Before introducing any Effect API or pattern not already present in the repo, confirm it exists in `.reference/effect-smol` and fits these rules.
