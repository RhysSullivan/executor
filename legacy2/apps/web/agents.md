# Effect Atom guide for `apps/web`

This file defines how we write Effect Atom code in this app.

## Goal

Keep React components dumb. Put async/result orchestration in atoms, and render from typed state objects.

## Hard rules

- Do not create query atoms in render with `useMemo`.
- Do not hand-roll `isLoading` / `hasError` booleans from `_tag` checks in components.
- Do not manually mirror server state with React local state.
- Prefer `Atom.family` + derived state atoms over component-level branching.

## Baseline stack

- `@effect-atom/atom`
- `@effect-atom/atom-react`
- `@executor-v2/control-plane` client (Effect HttpApi)

## Recommended structure

- `lib/control-plane/client.ts`
  - Export one shared `createControlPlaneAtomClient(...)` instance.
- `lib/control-plane/atoms.ts`
  - Export query/mutation atoms and derived state atoms.
- `app/.../page.tsx`
  - Use `useAtomValue`, `useAtomSet`, and `useAtomRefresh`.
  - Render from derived state atom output.

## Preferred patterns

### 1) Parametrized query atom with `Atom.family`

Create once at module scope:

```ts
const sourcesResultByWorkspace = Atom.family((workspaceId: WorkspaceId) =>
  controlPlaneClient.query("sources", "list", {
    path: { workspaceId },
  }),
);
```

Then in component:

```ts
const result = useAtomValue(sourcesResultByWorkspace(workspaceId));
```

No `useMemo` needed.

### 2) Derived state atom for UI projection

Map `Result` once in atom-land:

```ts
const sourcesByWorkspace = Atom.family((workspaceId: WorkspaceId) =>
  Atom.make((get) => {
    const result = get(sourcesResultByWorkspace(workspaceId));
    return Result.match(result, {
      onInitial: () => ({ state: "loading" as const, items: [] as const, message: null }),
      onFailure: (failure) => ({
        state: "error" as const,
        items: Option.getOrElse(Result.value(result), () => []),
        message: Cause.pretty(failure.cause),
      }),
      onSuccess: (success) => ({
        state: success.waiting ? ("refreshing" as const) : ("ready" as const),
        items: success.value,
        message: null,
      }),
    });
  }),
);
```

Components switch on `sources.state`, not raw result internals.

### 3) Mutations as atoms

Define mutation atoms once:

```ts
const upsertSource = controlPlaneClient.mutation("sources", "upsert");
const removeSource = controlPlaneClient.mutation("sources", "remove");
```

In components, execute with `useAtomSet(..., { mode: "promise" })`, then refresh the related query atom.

## React hooks usage

- `useAtomValue(atom)` for reads.
- `useAtomSet(writableAtom, { mode: "promise" })` for mutation execution.
- `useAtomRefresh(atom)` for explicit refresh.
- `useAtomSuspense(...)` is preferred when route is Suspense-driven.

## Error formatting

- Prefer `Cause.pretty(...)` for UI/debug text when surfacing failures.
- Keep raw `Cause` in atom-derived state when useful; do not stringify ad-hoc in JSX.

## Internal references

- `@effect-atom/atom` d.ts: `dist/dts/Atom.d.ts`, `dist/dts/Result.d.ts`, `dist/dts/AtomHttpApi.d.ts`
- `@effect-atom/atom-react` d.ts: `dist/dts/Hooks.d.ts`, `dist/dts/RegistryContext.d.ts`

## Anti-pattern checklist (reject in review)

- `useMemo(() => client.query(...), [deps])`
- `const isLoading = result._tag === "Initial" || ...`
- component-level `if/else` trees over raw `Result` in many places
- duplicating remote state into `useState` unless it is true form draft state
