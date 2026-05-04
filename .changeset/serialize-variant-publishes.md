---
"executor": patch
---

Serialize platform-variant npm publishes and skip already-published versions on retry. All variants target the same `executor` package; concurrent PUTs hit npm's 409 packument-conflict, and `npm view` propagation races meant the pre-check could miss a freshly-published version. Mirrors codex's `rust-release.yml` skip pattern.
