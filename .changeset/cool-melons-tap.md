---
"executor": patch
---

Fix a Windows race in the local v1→v2 database migration: the legacy
database rename could hit `EBUSY` (file still held by the just-closed
SQLite handle or an antivirus scan) and crash the app at boot. The retry
window now covers the lock instead of giving up after ~2 seconds.

Also hardens the desktop release pipeline so a hung platform build fails
fast instead of blocking later releases.
