---
name: wrdn-effect-promise-exit
description: Replace React/effect-atom mutation handlers that use promise-mode plus try/catch with promiseExit and explicit Exit handling. Use when lint or review flags try/catch around useAtomSet mutation calls, especially UI handlers that set error/busy state after a failed mutation.
allowed-tools: Read Grep Glob Bash
---

You fix one pattern: a React handler awaits an effect-atom mutation in `mode: "promise"` and catches failures with `try/catch`.

The preferred UI boundary is `mode: "promiseExit"` plus `Exit.isFailure`. This keeps mutation failures as values, matches Effect's error model, and prevents optimistic mutation cleanup from depending on thrown exceptions.

## Trace before changing

1. **Find the mutation setter.** Look for `const doX = useAtomSet(<mutationAtom>, { mode: "promise" })`.
2. **Confirm it is an effect-atom mutation boundary.** The setter should come from `@effect/atom-react` and a mutation atom from `./atoms`, `../api/atoms`, or plugin React atoms.
3. **Find thrown-control handling.** The same handler has `try { await doX(...) } catch (e) { ... }`, usually setting error text, resetting `adding`/`saving`, or showing a toast.
4. **Check for non-mutation async work in the same block.** If the block also awaits follow-up mutations, convert those to `promiseExit` too or keep a narrow boundary only around truly non-effect APIs.
5. **Do not rewrite unrelated local async code.** Probe requests, OAuth popup helpers, `fetch`, and browser APIs may need a different skill unless the lint finding specifically points at the mutation call.

## Fix shape

- Change the setter to `{ mode: "promiseExit" }`.
- Import `* as Exit from "effect/Exit"` if missing.
- Import `* as Option from "effect/Option"` only when extracting an optional error.
- Replace `try/catch` around the mutation with:
  - `const exit = await doX(args);`
  - `if (Exit.isFailure(exit)) { ...; return; }`
  - success work after the failure branch.
- Use `Exit.findErrorOption(exit)` when preserving an existing error message or typed error branch.
- Keep existing typed error handling when present, e.g. `SecretInUseError`, `ConnectionInUseError`.

## Bad

```tsx
const doAdd = useAtomSet(addGraphqlSource, { mode: "promise" });

const handleAdd = async () => {
  setAdding(true);
  setAddError(null);
  try {
    await doAdd({
      params: { scopeId },
      payload,
      reactivityKeys: sourceWriteKeys,
    });
    props.onComplete();
  } catch (e) {
    setAddError(e instanceof Error ? e.message : "Failed to add source");
    setAdding(false);
  }
};
```

## Good

```tsx
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

const doAdd = useAtomSet(addGraphqlSource, { mode: "promiseExit" });

const handleAdd = async () => {
  setAdding(true);
  setAddError(null);
  const exit = await doAdd({
    params: { scopeId },
    payload,
    reactivityKeys: sourceWriteKeys,
  });
  if (Exit.isFailure(exit)) {
    const error = Exit.findErrorOption(exit);
    setAddError(
      Option.isSome(error) && error.value instanceof Error
        ? error.value.message
        : "Failed to add source",
    );
    setAdding(false);
    return;
  }
  props.onComplete();
};
```

## Follow-up mutation chains

If success work depends on the mutation result, read it after the failure branch:

```tsx
const exit = await doAdd(args);
if (Exit.isFailure(exit)) {
  setAdding(false);
  return;
}

const sourceId = exit.value.namespace;
```

If a follow-up effect-atom mutation can fail and the UI treats that as add failure, make that setter `promiseExit` too and branch the same way. Do not put the follow-up mutation in `try/catch` just because the first mutation now returns `Exit`.

## What not to report

- `try/catch` around non-effect APIs such as `new URL`, `JSON.parse`, raw `fetch`, or browser popup code. Those may be real lint findings, but they need a different remediation skill.
- `useAtomSet(..., { mode: "promise" })` with no local failure handling and no lint finding. Some call sites intentionally let callers decide the boundary.
- Tests or SDK/server Effect code. This skill is for React/effect-atom UI mutation handlers.
- Manual optimistic placeholder cleanup. Use `wrdn-effect-atom-optimistic` for that; if both patterns appear together, fix optimistic plumbing first, then use `promiseExit` for the remaining mutation boundary.

## Output requirements

When reviewing, report:

- **File and line** of the `useAtomSet(..., { mode: "promise" })` or `try/catch`.
- **Mutation** being called.
- **Why** it should return `Exit` at this UI boundary.
- **Fix**: the exact setter mode and the failure branch to add.

When editing, keep changes local to the handler and imports unless a follow-up mutation in the same success path must also become `promiseExit`.
