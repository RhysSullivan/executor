---
name: wrdn-effect-atom-reactivity-keys
description: Add reactivityKeys to effect-atom write mutation calls. Use when lint flags a useAtomSet mutation call that mutates data without invalidation keys.
allowed-tools: Read Grep Glob Bash
---

Effect-atom write mutations must say which reads they invalidate.

## Fix Shape

- Find the `useAtomSet(...)` write mutation call.
- Add `reactivityKeys` to the mutation payload at the call site.
- Use the narrowest keys that cover the rows/lists affected by the write.
- Keep read-only probe/preview OAuth flows out of this pattern.
- If the mutation should update UI immediately, check whether `wrdn-effect-atom-optimistic` also applies.

## Good

```ts
await updateSource({
  params: { scopeId, sourceId },
  payload,
  reactivityKeys: [["sources", scopeId]],
});
```
