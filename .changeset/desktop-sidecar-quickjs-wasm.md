---
"@executor-js/desktop": patch
"executor": patch
---

Fix: desktop sidecar now stages the QuickJS WASM file next to the compiled
binary and preloads it at boot. Without this, MCP `execute` calls (and any
other code execution) hit `quickjs-emscripten`'s loader inside bunfs and
crashed with `ENOENT: emscripten-module.wasm`. Mirrors the standalone CLI's
preload pattern.
