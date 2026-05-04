---
name: cli-release
description: Runbook for releasing the `executor` CLI package (stable and beta). Covers scope of what ships with the CLI, user-facing changelog conventions, Changesets + Version Packages PR flow, beta train entry/exit, and owner preferences. Use when the user asks to cut a release, prepare release notes, enter/exit a beta train, or write changesets for the CLI.
---

# Executor CLI release runbook

## Authoritative doc
`RELEASING.md` at repo root is the source of truth. This skill encodes the owner's preferences on top of it.

## What the `executor` CLI actually ships

The CLI binary bundles:
- `apps/cli/**` — CLI source + daemon
- `apps/local/**` — the web UI (embedded as a virtual module via `apps/cli/src/build.ts:178`) + drizzle migrations (`build.ts:205`)
- `packages/**` — `core`, `kernel`, `hosts/mcp`, `runtime-quickjs`, and every plugin under `packages/plugins/**`

Does **not** ship in the CLI:
- `apps/cloud/**` (Cloudflare Workers deployment)
- `apps/marketing/**`, `apps/desktop/**`
- `examples/**`, `tests/**`

**Implication for changelogs**: when asked "what changed since the last release", scope is `git log v<last>..HEAD -- apps/cli apps/local packages`, not just `apps/cli`. Skipping `apps/local` and `packages` misses the bulk of product changes (Connections UI, OAuth plugins, SDK scope, OTEL, etc.).

## Versioning preferences

- Prior convention in this repo uses **`patch`** bumps for feature-heavy releases (see `.changeset/executor-1.4.6-beta.md` for precedent). Don't push back on patch unless there are genuine SemVer-breaking API changes to a library consumer surface.
- Breaking CLI UX changes (removed flags, changed argv shape) have historically still been `patch` bumps. Follow the owner's call — ask, don't assume `minor`.
- Normal release/patch PRs must add a `.changeset/*.md` file with frontmatter like `"executor": patch`. Do **not** directly bump `apps/cli/package.json` or `bun.lock` in a feature/fix PR.
- Only the Changesets-generated `Version Packages` PR should move `apps/cli/package.json`. If a normal PR directly changes that version, merging it to `main` can make `.github/workflows/release.yml` tag the commit and dispatch `publish-executor-package.yml`, causing an immediate CLI publish.
- `@executor-js/*` library packages have their own publish path.

## Release notes: single source of truth, curated, not auto-generated

The owner doesn't want GitHub's auto-generated "PR title by @user" list. Release notes live at `apps/cli/release-notes/` and `apps/cli/src/release.ts` prefers them over `--generate-notes`.

**`apps/cli/release-notes/next.md` is the canonical user-facing changelog.** Per-package workspace `CHANGELOG.md` files were removed in late 2026 — they were empty stubs and changesets does not regenerate them under `changelog: false`. Don't create them.

### How it's wired
`apps/cli/src/release.ts` reads `apps/cli/release-notes/next.md` and uses
its contents as the GitHub Release body. If the file is missing or empty,
falls back to `gh release create --generate-notes`. There's no
per-version archive in the repo — historical release bodies live on
GitHub Releases (durable, indexed, linkable).

### Writing conventions
Structure release-notes files as:
```
## Highlights
### <user-facing story>     # e.g. "Per-user OAuth for OpenAPI and MCP sources"
  bullets of concrete user value

## New presets              # optional

## Performance              # optional

## Fixes

## Breaking changes
### <specific surface>
  before / after code blocks for migrations
```

Lead with **user-visible stories**, not commit subjects. Group related commits into one story (e.g. 6 commits about Connections → one "Per-user OAuth" section). Include before/after CLI snippets for any breaking change. Keep bullets single-line.

### Attribution

External contributor bullets end with `Thanks @<user> (#PR)`:

```markdown
- OAuth2 client-credentials flow end-to-end. Thanks @octocat (#456)
```

Do not `Thanks` maintainers, bots, or the repo owner — the lint script rejects `@claude`, `@anthropic`, `@github-actions`, `@dependabot`, `@renovate`, `@rhyssullivan`, `@rhys-sullivan`. Run `bun run lint:release-notes` before pushing notes.

### When drafting from `git log`
- Look at `git diff v<last>..HEAD -- README.md` first — it's the best single view of user-facing changes.
- Read commit messages in bulk (`git log --oneline v<last>..HEAD -- apps/cli apps/local packages`), then bucket by theme before writing prose.
- Don't list every commit. Merge PRs and refactor-chain commits into one line.

### Pairing with changesets
- A `.changeset/*.md` describes the version bump (semver level + a short summary for the Version Packages PR description). It is **not** the user-facing changelog.
- If your PR adds a `.changeset/*.md` for the `executor` package, also edit `apps/cli/release-notes/next.md` for the user-facing story. They have different audiences.
- The `.changeset/*.md` body can be a one-liner pointing at the release-notes section it expands; users read the GitHub release body, not the changeset.
- Frontmatter is `"executor": patch` (or `minor`/`major` if owner says so).

### Starting a new release cycle
There's no post-release rename step. When you start work on the next
release, replace the existing `next.md` content with new entries — the
previous cycle's content is already preserved on the matching `vX.Y.Z`
GitHub Release page, so overwriting locally is safe. If `next.md` content
looks stale (i.e. mentions features already shipped), that's the signal
to clear it.

## Beta release flow

```
git checkout -b rs/beta-v<next>-start
bun run release:beta:start                 # creates .changeset/pre.json
# write .changeset/executor-<next>-beta.md (patch frontmatter by default)
# write apps/cli/release-notes/next.md     (curated notes)
git add ... && git commit                  # ONLY when owner says commit
git push -u origin rs/beta-v<next>-start
# Open PR -> merge -> release.yml opens "Version Packages (beta)" PR -> merge to publish
```

- Published under npm dist-tag `beta`.
- Users install: `npm i -g executor@beta`.
- Exit the train with `bun run release:beta:stop` when going back to stable.

## Stable release flow

Identical to beta except skip `release:beta:start`/`stop`. Changesets produce a normal `Version Packages` PR; merging publishes under `latest`.

## Owner preferences (hard rules)

- **Never commit until the owner explicitly says so.** Set everything up in the working tree, run `git status`, and stop.
- **No AI / Claude / Anthropic / Co-Authored-By trailers** in commits, commit messages, PRs, or any generated file. This is in `CLAUDE.md` — do not violate.
- **Branch naming**: `rs/<short-topic>` for Rhys's branches. Beta-start branch: `rs/beta-v<version>-start`.
- **Remote**: `origin` = `https://github.com/RhysSullivan/executor.git`. If another remote appears (e.g. a fork remote), ask whether to remove it.
- **Dirty working tree**: if there are uncommitted changes when starting a release, ask whether to include them, stash them, or commit separately first. Don't sweep them into the release commit silently.
- **Don't estimate time** — code is cheap to write. Focus on what to do, not how long it takes.
- **Fact-check scope claims** before publishing. If release notes say "does not affect X", verify by reading the diff.

## Common commands

```
bun run changeset                          # interactive; or write .changeset/*.md directly
bun run lint:release-notes                 # validate apps/cli/release-notes/next.md
bun run release:beta:start                 # enter prerelease
bun run release:beta:stop                  # exit prerelease
bun run release:publish:dry-run            # build full CLI payload without publishing
bun run release:publish:packages:dry-run   # pack @executor-js/* without publishing
bun run release:check                      # invoked by publish workflow
```

## What the workflow does after merge to `main`

1. `.github/workflows/release.yml` opens/updates a `Version Packages` PR.
2. Merging that PR:
   - Publishes every `@executor-js/*` library that's not yet on npm (via `scripts/publish-packages.ts`).
   - If `apps/cli/package.json` bumped, tags the commit and dispatches `publish-executor-package.yml`, which runs `release:check`, does a full dry-run build, publishes the CLI to npm, and creates/updates the GitHub Release with binary assets.

## Fallback behavior

If something is unclear (bump level, whether to include in-flight work, whether to push), **ask the owner**. A release is a high-blast-radius action; one clarifying question is cheaper than a rogue publish.
