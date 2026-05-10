---
"executor": patch
---

Fix CLI failing to start with `SQLiteError: parser stack overflow` after upgrading to 1.4.16. Migration `0008_scoped_credentials_cutover.sql` inlined a 41-deep nested `replace(replace(... lower(...) ...))` chain to slugify header names; bun:sqlite's lemon parser stack overflows at that depth on the compiled CLI binary on macOS. Slug computation is now precomputed once into a `__slug_norm` temp table at the top of the migration and referenced via flat scalar subqueries everywhere it's used.
