---
"@executor-js/sdk": minor
"executor": minor
---

Add `executor generate`: emit a typed TypeScript client for an instance's tool catalog.

Running `executor generate` against a server writes a single self-contained
file (default `executor.gen.ts`) with a dependency-free runtime client and
full input/output types for every visible tool, so
`client.github.org.main.issues.create({ title })` is typed end to end and
calls go through the server's execution endpoint (auth, policies, and
approvals included). New `GET /tools/export` endpoint and
`executor.tools.export()` SDK surface return the whole schema-bearing catalog
in one read; generation compiles schemas in chunks and stays fast at
10,000-tool scale.
