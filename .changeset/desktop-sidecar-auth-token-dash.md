---
"executor": patch
---

Fix the desktop app failing to start its local server when the generated auth token begins with a dash. The token is `randomBytes(32).toString("base64url")`, which can start with "-", and the packaged app passed it to the bundled CLI as a separate argument (`--auth-token`, then the token). The CLI then read the leading-dash token as an unknown flag, printed its help, and exited, so the desktop showed a fatal "local Executor server crashed during startup" dialog. This was persistent (the token is saved) and cross-platform, affecting roughly 1 in 64 fresh installs. The token is now passed in the combined `--auth-token=<value>` form so a leading dash is treated as the value.
