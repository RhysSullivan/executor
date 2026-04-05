# Releasing

This repo uses Changesets for version orchestration and a custom publish script for the generated `executor` npm package plus its platform packages.

## Normal release flow

1. Add a changeset in the PR that should ship:
   - `bun run changeset`
2. Merge that PR to `main`.
3. `.github/workflows/release.yml` opens or updates a `Version Packages` PR.
4. Merge the `Version Packages` PR.
5. The release workflow tags the commit and dispatches `.github/workflows/publish-executor-package.yml`.
6. The publish workflow:
   - runs `bun run release:check`
   - performs a full dry-run release build before publish
   - publishes npm packages under the correct dist-tag
   - creates or updates the GitHub release with build artifacts

## Beta releases

Enter prerelease mode before starting a beta train:

- `bun run release:beta:start`

That commits `.changeset/pre.json` into the repo and causes future release PRs to produce versions like `1.5.0-beta.0`, `1.5.0-beta.1`, and so on.

When the beta train is done:

- `bun run release:beta:stop`

Stable versions publish to npm under `latest`.
Beta versions publish to npm under `beta`.

## Local dry run

To build the full release payload without publishing to npm or GitHub:

- `bun run release:publish:dry-run`

That produces:

- platform archives in `apps/cli/dist`
- the packed wrapper tarball in `apps/cli/dist/release`

## Notes

- Changesets owns the published CLI version via `apps/cli/package.json`.
- Changesets changelog file generation is disabled; GitHub release notes are generated at publish time instead.
- `apps/cli/CHANGELOG.md` is kept as a compatibility file for the Changesets GitHub Action release PR flow.
- `scripts/release/sync-versions.mjs` propagates that version across the rest of the repo manifests after `changeset version` runs.
- The publish workflow supports either npm trusted publishing or an `NPM_TOKEN` secret.
- Re-running the publish workflow for the same tag is safe for packages that are already on npm; existing versions are skipped.
