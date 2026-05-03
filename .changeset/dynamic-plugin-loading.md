---
"@executor-js/config": minor
---

Add `plugins` field to `executor.jsonc` schema and `loadPluginsFromJsonc` loader so the host can resolve plugin packages dynamically at boot via jiti instead of statically importing them in `executor.config.ts`.
