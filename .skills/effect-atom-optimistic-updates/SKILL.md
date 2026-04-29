---
name: effect-atom-optimistic-updates
description: Pattern for implementing optimistic UI updates with effect-atom in this codebase. Use when adding optimistic behavior to a query atom + its mutations (action toggles, list adds/removes, inline edits). DO NOT roll your own pending-state with React state, Maps, or custom merge helpers — `Atom.optimistic` + `Atom.optimisticFn` already handle racing, refresh, and waiting correctly.
---

# effect-atom Optimistic Updates

The `@effect-atom/atom-react` library ships first-class optimistic support via
`Atom.optimistic` and `Atom.optimisticFn`. Use them directly. Do not write a
custom "pending entries" layer (Maps, useState, useRef) on top of `useAtomValue`
— it will not handle racing updates correctly, and the existing helpers in
`packages/react/src/api/optimistic.tsx` are legacy patterns kept only for
sources/connections.

## When to use

- A list query atom (`Atom.optimistic` wraps the query)
- Plus one or more mutation atoms that change rows in that list (create / update / delete)
- And you want the UI to reflect the change *immediately* on click, before the server roundtrip

If you only need the UI to be "eventually consistent" (i.e. you're fine waiting
~200ms for the server response and the existing reactivity refetch), skip
optimistic — just use the mutation directly with `reactivityKeys`.

## Why not roll your own

The naive approach — track `pending: Array<{id, value}>` in a separate atom and
merge it with the server result — has a subtle race that bites on rapid edits:

1. User clicks "set action = block" → mutation A fires, pending entry written
2. User clicks "set action = approve" → mutation B fires, pending entry overwritten with B
3. **A's response returns first** → finally-block clears the pending entry → UI flickers back to the server's "block" value
4. B's response returns → UI shows "approve"

Step 3 is the bug. Fixing it correctly requires per-call entry ids and "last
entry per row id wins" merging — at which point you've reimplemented a worse
version of `Atom.optimistic`'s transition tracking.

`Atom.optimistic` solves this because the runtime reads the current optimistic
state (including any in-flight transitions) and passes it to your reducer as
`current`, so B stacks on top of A correctly. When all transitions settle, it
calls `refresh(self)` to pull the server's authoritative state.

## Pattern

Define optimistic atoms next to the underlying query and mutations in the
`atoms.tsx` (or equivalent) module. Each scope-keyed list gets a family that
wraps the query with `Atom.optimistic`, and each mutation gets a family that
pipes the optimistic atom through `Atom.optimisticFn` with a reducer.

```typescript
import { Atom, Result } from "@effect-atom/atom-react";
import type { ScopeId, PolicyId, ToolPolicyAction } from "@executor/sdk";

import { ExecutorApiClient } from "./client";

// 1. The plain query atom — same as before.
export const policiesAtom = (scopeId: ScopeId) =>
  ExecutorApiClient.query("policies", "list", {
    path: { scopeId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.policies],
  });

// 2. Plain mutations — same as before. These are the underlying `fn` for
//    the optimistic wrappers below.
export const createPolicy = ExecutorApiClient.mutation("policies", "create");
export const updatePolicy = ExecutorApiClient.mutation("policies", "update");
export const removePolicy = ExecutorApiClient.mutation("policies", "remove");

// 3. Optimistic read atom. `Atom.family` memoizes per-scope so every consumer
//    references the same optimistic atom instance and shares transition state.
export const policiesOptimisticAtom = Atom.family((scopeId: ScopeId) =>
  Atom.optimistic(policiesAtom(scopeId)),
);

// 4. Optimistic mutation. The reducer takes the same arg as the underlying
//    mutation and returns the next list state. `Result.map` keeps the
//    Result wrapper intact.
export const updatePolicyOptimistic = Atom.family((scopeId: ScopeId) =>
  policiesOptimisticAtom(scopeId).pipe(
    Atom.optimisticFn({
      reducer: (
        current,
        arg: {
          path: { scopeId: ScopeId; policyId: PolicyId };
          payload: { action?: ToolPolicyAction };
          reactivityKeys?: ReadonlyArray<unknown>;
        },
      ) =>
        Result.map(current, (rows) =>
          rows.map((r) =>
            r.id === arg.path.policyId && arg.payload.action !== undefined
              ? { ...r, action: arg.payload.action }
              : r,
          ),
        ),
      fn: updatePolicy,
    }),
  ),
);
```

## Consuming in components

Read from the optimistic atom; write through the optimistic mutation. The
existing `reactivityKeys` plumbing still applies — pass them in the call.

```typescript
import { useAtomValue, useAtomSet } from "@effect-atom/atom-react";

import {
  policiesOptimisticAtom,
  updatePolicyOptimistic,
} from "../api/atoms";
import { policyWriteKeys } from "../api/reactivity-keys";

export function PoliciesPage() {
  const scopeId = useScope();

  // Read: this Result reflects in-flight optimistic state on top of server data.
  const policies = useAtomValue(policiesOptimisticAtom(scopeId));

  // Write: same call signature as the underlying mutation.
  const doUpdate = useAtomSet(updatePolicyOptimistic(scopeId), { mode: "promise" });

  const handleUpdate = async (id: string, action: ToolPolicyAction) => {
    await doUpdate({
      path: { scopeId, policyId: PolicyId.make(id) },
      payload: { action },
      reactivityKeys: policyWriteKeys,
    });
  };

  // ...
}
```

## Reducer rules

1. **`current` is the FULL Result, not the unwrapped value.** Use `Result.map`
   to update inside the success case — the wrapper preserves Initial/Failure
   states correctly.
2. **The reducer is called for every transition, including ones that stack on
   top of in-flight ones.** Read `current` and produce `next` — don't track
   "the previous optimistic value" yourself.
3. **The reducer signature must match the mutation's arg shape.** Effect-atom
   passes the raw mutation arg (e.g. `{ path, payload, reactivityKeys }`) to
   both the reducer and the underlying `fn`. Don't try to build a "nicer" arg
   shape unless you also wrap the underlying mutation.
4. **Be pure.** No side effects, no calls to `Date.now()` for stable values,
   no random ids unless you need a placeholder row id (see "Adds" below).

## Adds (server mints the id)

For create flows the server assigns the canonical id. The reducer inserts a
placeholder with a temp id — the post-commit refresh replaces it with the
canonical row.

```typescript
export const createPolicyOptimistic = Atom.family((scopeId: ScopeId) =>
  policiesOptimisticAtom(scopeId).pipe(
    Atom.optimisticFn({
      reducer: (
        current,
        arg: {
          path: { scopeId: ScopeId };
          payload: { pattern: string; action: ToolPolicyAction };
          reactivityKeys?: ReadonlyArray<unknown>;
        },
      ) =>
        Result.map(current, (rows) => [
          {
            id: PolicyId.make(`pending-${Math.random().toString(36).slice(2)}`),
            scopeId,
            pattern: arg.payload.pattern,
            action: arg.payload.action,
            position: -Number.MAX_SAFE_INTEGER, // sort to top
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          ...rows,
        ]),
      fn: createPolicy,
    }),
  ),
);
```

The placeholder doesn't need to roundtrip through the `id` field unless your
list rendering keys on it (it usually does — `<Row key={p.id}>`). A unique
prefix like `pending-` is fine.

## Removes

```typescript
export const removePolicyOptimistic = Atom.family((scopeId: ScopeId) =>
  policiesOptimisticAtom(scopeId).pipe(
    Atom.optimisticFn({
      reducer: (
        current,
        arg: {
          path: { scopeId: ScopeId; policyId: PolicyId };
          reactivityKeys?: ReadonlyArray<unknown>;
        },
      ) =>
        Result.map(current, (rows) =>
          rows.filter((r) => r.id !== arg.path.policyId),
        ),
      fn: removePolicy,
    }),
  ),
);
```

## How racing is handled (mental model)

You don't have to think about this — it works — but understanding helps:

- `Atom.optimistic(self)` wraps the underlying atom and tracks a `transitions` set
- Each `Atom.optimisticFn` call creates one shared transition state per (scope, mutation)
- A call: runtime reads the current optimistic state (including in-flight transitions), invokes `reducer(current, arg) → value`, sets transition to `Success(value, waiting=true)`, calls the underlying mutation `fn` with `arg`
- The next call to the same optimisticFn sees the prior call's optimistic value as `current` — so it stacks on top
- When `fn` settles, both calls' subscribers fire, the transition flips to non-waiting, and `refresh(self)` pulls the server state
- The server's authoritative response replaces the optimistic state via the
  underlying atom's normal subscribe path

Net result: rapid edits look smooth, the last edit wins both visually and on
the server, no flickers, no manual cleanup.

## Things to avoid

- ❌ `useState`/`useRef` to hold pending values
- ❌ `Map` / `Set` of in-flight ids
- ❌ Custom `mergePending` helpers
- ❌ `try/finally` blocks that "clear the placeholder" — `optimistic` clears for you
- ❌ Reading `policiesAtom` directly in the component while writing through `updatePolicyOptimistic` — they have different transition state, you'll see jumps

## Reference implementation

`packages/react/src/api/atoms.tsx` (search for `policiesOptimisticAtom`) and
`packages/react/src/pages/policies.tsx` show the full pattern: optimistic
read, optimistic create/update/remove, no custom state.

## When you must NOT use this

- The mutation has cross-cutting effects on data that *isn't* in the same list
  (e.g. a single mutation invalidates `tools` AND `policies`). Reactivity keys
  still handle that — optimistic only paints the list-local change.
- You need to show transient UI state that isn't a row property (toasts,
  dirty indicators per field, pending counts). Those belong in component state,
  not in the atom layer.
