---
"executor": patch
"@executor-js/sdk": patch
"@executor-js/plugin-openapi": patch
"@executor-js/plugin-graphql": patch
---

**Faster integrations with large API specs**

Resolved OpenAPI spec text and GraphQL introspection snapshots are now stored content-addressed in the plugin blob store instead of inline in each integration's stored config. Listing integrations no longer loads multi-megabyte spec blobs it immediately discards, which makes the integrations surface dramatically faster for workspaces with large specs. Existing integrations keep working: rows that still inline a spec resolve unchanged and are rewritten in place the next time they are imported or refreshed.
