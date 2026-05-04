---
"executor": patch
---

Distribute platform binaries via npm `optionalDependencies` instead of a postinstall download from GitHub Releases. Each `executor-<plat>-<arch>` package publishes with `os`/`cpu` filters so npm/bun only fetches the matching binary. Postinstall is a fast-path symlink and always exits 0, with the launcher walking `node_modules` (and falling back between glibc/musl on Linux) at runtime — so blocked postinstalls (e.g. default `bun i -g`) are non-fatal. Adds `scripts/install.sh` for the no-node-at-all case.
