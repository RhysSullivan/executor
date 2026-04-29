---
name: wrdn-effect-atom-optimistic
description: Detects hand-rolled optimistic-update plumbing in React code that should be using effect-atom's Atom.optimistic and Atom.optimisticFn instead. Run on diffs touching packages/react/src/api/atoms.tsx, packages/react/src/pages/**/*.tsx, or any file that imports an effect-atom mutation atom from ./api/atoms. The hand-rolled patterns race on concurrent mutations and the codebase has chosen the effect-atom primitives as the canonical answer.
allowed-tools: Read Grep Glob Bash
---

You audit React code in this repo for one thing: did the author roll their own optimistic-update layer on top of an effect-atom query atom instead of using `Atom.optimistic` / `Atom.optimisticFn`?

This is not a security skill. It is a correctness skill. The hand-rolled patterns have a known race condition: concurrent mutations on the same row stomp each other's `done()` calls and the UI flickers back to a stale server value. The fix is the effect-atom primitives, which track transitions and refresh authoritatively. The repo already migrated `policies` and codified the pattern at `.skills/effect-atom-optimistic-updates/SKILL.md`.

Trace. Do not pattern-match a `useState` and call it a day. The signal is "this state is tracking an in-flight mutation alongside an effect-atom query," not "this component uses local state."

## Trace before reporting

1. **Find the mutation.** Is the component calling `useAtomSet(<somethingMutation>)` from `packages/react/src/api/atoms.tsx`? If not, this skill does not apply.
2. **Find the read.** Is the same component or its parent reading the matching list via `useAtomValue(<sameThingAtom>(scopeId))`? If yes, the optimistic substitute exists or should exist.
3. **Find the bookkeeping.** Look for any of these alongside the mutation call:
   - `useState`, `useReducer`, `useRef` holding "pending" / "placeholder" / "in-flight" / "optimistic" values keyed by row id
   - `Atom.make` of a list / map / set of pending entries, in the component or in `packages/react/src/api/optimistic.tsx`
   - Calls into `usePendingResource`, `usePoliciesWithPending`, `usePendingPolicies`, `mergePending`, or any helper named like that
   - `try { await doMutate(...) } finally { placeholder.done() }` shapes
   - Manual id minting (`pending-${...}`, `crypto.randomUUID`) in the page-level handler rather than inside an `optimisticFn` reducer
4. **Confirm the optimistic atom exists or is missing.** Open `packages/react/src/api/atoms.tsx` and check for `<thing>OptimisticAtom = Atom.family(scopeId => Atom.optimistic(<thing>Atom(scopeId)))`. If a sibling resource (sources, secrets, policies) has the optimistic wrapper and this one doesn't, the bug is the missing wrapper plus the hand-rolled substitute.
5. **Check for grandfathered code.** `usePendingSources`, `useSourcesWithPending`, `useConnectionsWithPendingRemovals`, and `usePendingConnectionRemovals` in `packages/react/src/api/optimistic.tsx` are legacy. New code should not extend them. Their continued existence is not a finding by itself; **new** consumers or **new** entries in `PendingResource` are.

When the trace cannot resolve with the files at hand, drop the finding.

## What to Report

- **Hand-rolled pending state next to an effect-atom mutation.** Component imports a mutation from `./api/atoms` (e.g. `updatePolicy`, `createSecret`, `removeConnection`) and tracks the in-flight value in `useState` / `useRef` / a custom atom for the purpose of immediate UI feedback. Severity: medium.
- **New entries in `PendingResource` or new helpers in `packages/react/src/api/optimistic.tsx`.** The file is closed for new patterns. New rows, new `usePending<X>` hooks, new `use<X>WithPending` hooks should instead be `Atom.optimistic` + `Atom.optimisticFn` families in `atoms.tsx`. Severity: medium.
- **`try/finally` cleanup of a placeholder around `await doMutate(...)`.** This shape is the tell. `optimisticFn` clears its own transition; manual cleanup means the author is reimplementing it. Severity: medium.
- **Reading `<thing>Atom(scopeId)` in a component that also writes through `<thing>OptimisticAtom`'s mutations.** The reads and writes must both go through the optimistic family or both bypass it; mixing them produces visual jumps. Severity: medium.
- **`Atom.optimisticFn` reducer that derives next state from a captured snapshot of the parent atom instead of from the `current` argument.** The reducer signature is `(current, update) => W` — the runtime reads the optimistic state itself and passes it as `current`, which already reflects in-flight transitions. Code that closes over a `useAtomValue(...)` snapshot or a captured `policies` variable instead of using `current` will see stale state under racing edits. A placeholder row id derived from `Date.now()` or random is fine; the bug is reducer state that ignores `current`. Severity: low.
- **`Atom.optimistic` wrapped via `Atom.optimistic(policiesAtom(scopeId))` outside an `Atom.family`.** Without `Atom.family`, every render builds a new optimistic atom and transitions don't share state. Severity: medium.

## What NOT to Report

- `useState` / `useReducer` for UI-local state that has nothing to do with mutation lifecycle: form input values, modal open flags, hover state, derived display values. Read the surrounding code; if there is no `useAtomSet` or `await doMutate` near the state, it is not in scope.
- The legacy hooks themselves in `packages/react/src/api/optimistic.tsx` (`useSourcesWithPending`, `useConnectionsWithPendingRemovals`, `usePendingSources`, `usePendingConnectionRemovals`). Existing call sites are grandfathered. Only flag **new** call sites or **new** helpers added to that file.
- `useState` for a "busy" / "submitting" boolean used to disable a button while the mutation runs. That is not optimistic state.
- `setTimeout` / `setInterval` based debouncing or rate-limiting around a mutation. Different concern.
- Toast / error-message state. UI feedback, not optimistic data.
- Server-only code (`apps/cloud`, `apps/local`, `packages/core/**`). This skill is React-specific; do not flag backend handlers, plugin storage, or test helpers.
- Storybook files, test files, and example-only code. The pattern matters in shipped UI; not in fixtures.

## Severity ladder

| Level | Criteria |
|-------|----------|
| **medium** | New optimistic-mutation code that bypasses `Atom.optimistic` / `Atom.optimisticFn` and rolls its own pending state. Or a mixed read/write where the read goes through the plain query atom and the write goes through the optimistic mutation. |
| **low** | Subtle defects in an `Atom.optimisticFn` reducer that work today but degrade under racing (clock-based identity, missing `Atom.family` wrapper, computed-once captures of `scopeId`). |

Do not invent `high`. Pick `low` when in doubt and explain why.

## Reference patterns (TypeScript)

The repo's reference implementation lives in `packages/react/src/api/atoms.tsx` (search for `policiesOptimisticAtom`, `updatePolicyOptimistic`).

### Bad: hand-rolled pending state

```tsx
// packages/react/src/pages/secrets.tsx (hypothetical)
import { useState } from "react";
import { useAtomSet, useAtomValue } from "@effect-atom/atom-react";

import { secretsAtom, updateSecret } from "../api/atoms";

export function SecretsPage() {
  const scopeId = useScope();
  const secrets = useAtomValue(secretsAtom(scopeId));
  const doUpdate = useAtomSet(updateSecret, { mode: "promise" });
  const [pendingValue, setPendingValue] = useState<Map<string, string>>(new Map());

  const handleEdit = async (id: string, value: string) => {
    setPendingValue((m) => new Map(m).set(id, value));
    try {
      await doUpdate({ path: { scopeId, secretId: id }, payload: { value } });
    } finally {
      setPendingValue((m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      });
    }
  };
  // ...
}
```

The `Map` keyed by id, the `try/finally`, the manual cleanup. All three signal a hand-rolled optimistic layer. Two fast edits to the same secret race: A's `finally` deletes B's pending entry, UI flickers to A's server value before B settles.

### Safe: effect-atom primitives

```tsx
// packages/react/src/api/atoms.tsx
export const secretsOptimisticAtom = Atom.family((scopeId: ScopeId) =>
  Atom.optimistic(secretsAtom(scopeId)),
);

export const updateSecretOptimistic = Atom.family((scopeId: ScopeId) =>
  secretsOptimisticAtom(scopeId).pipe(
    Atom.optimisticFn({
      reducer: (current, arg: { path: { secretId: SecretId }; payload: { value: string } }) =>
        Result.map(current, (rows) =>
          rows.map((r) =>
            r.id === arg.path.secretId ? { ...r, value: arg.payload.value } : r,
          ),
        ),
      fn: updateSecret,
    }),
  ),
);

// packages/react/src/pages/secrets.tsx
const secrets = useAtomValue(secretsOptimisticAtom(scopeId));
const doUpdate = useAtomSet(updateSecretOptimistic(scopeId), { mode: "promise" });

const handleEdit = (id: SecretId, value: string) =>
  doUpdate({ path: { scopeId, secretId: id }, payload: { value } });
```

No local state, no try/finally, no manual cleanup. Multiple edits stack: the runtime feeds each reducer call `current` reflecting prior in-flight transitions, so the second edit sees the optimistic value of the first.

### Bad: extending the legacy layer

```tsx
// packages/react/src/api/optimistic.tsx (hypothetical addition)
export const PendingResource = {
  sources: "sources",
  connectionRemovals: "connection-removals",
  secrets: "secrets", // <-- new
} as const;

export interface PendingSecret {
  readonly value: string;
}

export const useSecretsWithPending = (scopeId: ScopeId) => { /* ... */ };
export const usePendingSecrets = () => { /* ... */ };
```

Flag any new entry in `PendingResource` and any new `use<X>WithPending` / `usePending<X>` hook. The file is closed for new patterns.

### Subtle: missing Atom.family wrapper

```tsx
// Bad: builds a fresh optimistic atom every render. No transition state survives.
const optimistic = Atom.optimistic(secretsAtom(scopeId));
const value = useAtomValue(optimistic);
```

```tsx
// Safe: Atom.family memoizes per scopeId so transitions persist.
export const secretsOptimisticAtom = Atom.family((scopeId: ScopeId) =>
  Atom.optimistic(secretsAtom(scopeId)),
);

const value = useAtomValue(secretsOptimisticAtom(scopeId));
```

## Output Requirements

For each finding:

- **File and line** of the offending code.
- **Severity** from the ladder above.
- **What is wrong**, in one sentence.
- **Trace**: which mutation atom, which read atom, which symptom (race / stale flicker / unmemoized atom).
- **Fix**: name the optimistic family that should exist, or the change that lifts the page's hand-rolled state into `atoms.tsx`. Point to `packages/react/src/api/atoms.tsx` (`policiesOptimisticAtom`) as the reference shape.

Group findings by severity. Lead with `medium`.
