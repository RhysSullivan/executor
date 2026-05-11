---
"@executor-js/codemode-core": patch
"@executor-js/plugin-example": patch
---

Fix two published-bundle bugs surfaced by `release:smoke:packages`:

- `@executor-js/codemode-core`: import `ajv/dist/2020.js` instead of
  `ajv/dist/2020`. Strict ESM resolvers (Node) reject extension-less
  subpath imports, so the published bundle failed at load with
  `Cannot find module '.../ajv/dist/2020'`. Bun's loose resolver hid
  the bug in dev.
- `@executor-js/plugin-example`: switch `HttpApiEndpoint` /
  `HttpApiGroup` / `HttpApi` / `HttpApiBuilder` imports in
  `./shared` and `./server` from `@executor-js/sdk` to
  `@executor-js/sdk/core`. The slim `.` entry (built from
  `src/promise.ts`) doesn't re-export the HttpApi primitives — only
  the `/core` entry (built from `src/index.ts`) does. In dev both
  subpaths resolve to the same source file, so typecheck never caught
  the mismatch; consumers installing the published tarball got
  `SyntaxError: ... does not provide an export named 'HttpApiEndpoint'`.
