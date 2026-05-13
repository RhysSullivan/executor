---
name: wrdn-typescript-type-safety
description: Remove TypeScript escape hatches. Use when lint flags @ts-nocheck or similar broad type bypasses.
allowed-tools: Read Grep Glob Bash
---

Fix the type boundary instead of disabling TypeScript.

## Fix Shape

- Remove `@ts-nocheck`.
- Narrow the failing expression, add a schema/guard at an unknown boundary, or improve the local type.
- If a cast is unavoidable, keep it narrow and document the invariant at the cast site.
- Do not silence an entire file for a localized mismatch.
