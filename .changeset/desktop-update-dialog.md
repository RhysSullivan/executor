---
"executor": patch
---

Desktop: surface available updates with a native dialog instead of swapping silently on quit. When a new version finishes downloading in the background, a "Restart now / Later" dialog fires so users actually know there's an update ready. Adds a `Check for Updates…` item to the app menu for manual checks. `electron-updater`'s `autoInstallOnAppQuit` is now off — the only way the new version applies is when the user chooses Restart now.
