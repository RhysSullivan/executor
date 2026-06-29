---
"@executor-js/plugin-graphql": patch
---

Fix the GraphQL plugin generating invalid operations against large schemas, and make field selection caller-controlled instead of a baked-in guess.

Previously each tool froze a recursive, depth- and count-bounded selection at sync time. Against a rich schema (GitLab) this produced invalid GraphQL (composite fields with no sub-selection, nested fields missing required arguments) so every call over a rich return type failed, and the arbitrary bound silently truncated which fields came back.

Generated tools now default to selecting only scalar/enum leaf fields of the return type (always valid, always within a server's query-complexity budget), and expose an optional `select` input carrying a GraphQL selection set so a caller can request nested or list data per call (including supplying nested required arguments). Fixes #1146.
