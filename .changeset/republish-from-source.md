---
"@executor-js/sdk": patch
"@executor-js/cli": patch
"@executor-js/fumadb": patch
---

Republish from committed source. Versions 1.5.5 and 1.5.6 of the library packages were published directly to npm to fix installs resolving the wrong `fumadb` dependency (the vendored database layer is now scoped as `@executor-js/fumadb`); that fix landed in the repo separately, and this release brings the recorded package versions back in line with npm.
