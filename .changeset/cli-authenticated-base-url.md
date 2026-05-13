---
"executor": patch
"@executor-js/desktop": patch
---

Allow CLI commands to target authenticated local runtimes with `--base-url` or `EXECUTOR_BASE_URL`, report local 401 responses instead of starting a duplicate daemon, and let Desktop attach to an existing unauthenticated CLI daemon using the shared `~/.executor-global` scope.
