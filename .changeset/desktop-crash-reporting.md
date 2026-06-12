---
"executor": patch
---

**Desktop crash reporting and diagnostics**

- The desktop app now reports crashes from all of its processes (window, main, and the local server sidecar), so launch failures and silent exits become fixable bugs instead of mysteries. Reporting is disabled in local/dev builds and honors `DO_NOT_TRACK=1` as an opt-out.
- If the local server crashes, the app shows a crash screen with restart and update actions instead of closing silently, and the server's output is persisted to the log file.
- New **Export Diagnostics** (menu and Settings) zips logs, crash dumps, and a redacted system manifest to Downloads — never secrets or executor data — and **Report a Problem…** prefills a GitHub issue with the diagnostics attached.
