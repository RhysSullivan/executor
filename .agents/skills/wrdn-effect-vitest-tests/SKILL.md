---
name: wrdn-effect-vitest-tests
description: Keep tests deterministic and Effect-aware. Use when lint flags direct vitest imports or conditional assertions inside tests.
allowed-tools: Read Grep Glob Bash
---

Use `@effect/vitest` for tests in this repo.

## Fix Shape

- Import `describe`, `it`, `expect`, and helpers from `@effect/vitest`.
- Import utility helpers from `@effect/vitest/utils` when needed.
- Do not import from raw `vitest` except in config or tooling files.
- Do not put `expect(...)` behind `if`, ternary, logical, or switch branches.
- Split conditional behavior into separate tests, or assert the branch condition and expected value explicitly.

## Bad

```ts
if (result.ok) {
  expect(result.value).toBe("x");
}
```

## Good

```ts
expect(result).toEqual({ ok: true, value: "x" });
```
