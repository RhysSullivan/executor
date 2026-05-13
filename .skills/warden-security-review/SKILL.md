---
name: warden-security-review
description: Run Warden security scans in this repo using Sentry's warden-skills. Use when asked to audit security, scan with Warden, investigate authz/data-exfil/code-execution/GitHub Actions risks, or triage Warden findings.
---

# Warden security review runbook

Use Warden as a first-pass scanner, then manually verify every finding against the code. A clean Warden run means "no findings from that skill/pass", not "the codebase is secure."

## Setup

Warden uses Claude Code auth locally. For Claude Max usage:

```bash
claude login
```

Run Warden through npm so the package version does not need to be committed:

```bash
npm exec --yes --package=@sentry/warden -- warden --help
```

The repo has a `warden.toml` that uses remote skills from `getsentry/warden-skills`.

Reference skills are mirrored under `.reference/warden-skills` when needed. `.reference/` is gitignored.

## Local Outputs

Write run artifacts under `.warden-runs/`. Do not commit `.warden/` or `.warden-runs/`.

Use JSONL output for later triage:

```bash
mkdir -p .warden-runs
npm exec --yes --package=@sentry/warden -- \
  warden <targets...> --skill <skill> --fail-on off --report-on low --min-confidence low \
  --parallel 2 --log -o .warden-runs/<name>.jsonl
```

Warden may not treat bare directories as recursive targets. Prefer explicit quoted globs or a target file list.

## Recommended Scans

Authz on cloud/API surfaces:

```bash
npm exec --yes --package=@sentry/warden -- \
  warden "apps/cloud/src/auth/**/*.ts" "apps/cloud/src/api/**/*.ts" \
  "apps/cloud/src/routes/**/*.tsx" "packages/core/api/src/**/*.ts" \
  --skill wrdn-authz --fail-on off --report-on low --min-confidence low \
  --parallel 2 --log -o .warden-runs/authz.jsonl
```

Code execution on sink-bearing runtime/plugin files:

```bash
rg -l "\b(exec|spawn|execFile|fork|subprocess|Deno\.Command|new Function|eval\(|vm\.|QuickJS|quickjs|Worker\(|import\(|compile|instantiate|runIn|shell|command|child_process)\b" \
  apps/local/src/server apps/cli/src packages/core/execution/src packages/core/sdk/src packages/kernel packages/plugins \
  -g "*.ts" -g "*.tsx" -g "!*.test.ts" -g "!*.spec.ts" -g "!*.e2e.ts" -g "!**/dist/**" -g "!**/node_modules/**" \
  > .warden-runs/code-execution-targets.txt

npm exec --yes --package=@sentry/warden -- \
  warden $(tr '\n' ' ' < .warden-runs/code-execution-targets.txt) \
  --skill wrdn-code-execution --fail-on off --report-on low --min-confidence low \
  --parallel 2 --log -o .warden-runs/code-execution.jsonl
```

Data exfiltration on backend/API/storage/plugin SDK surfaces:

```bash
find apps/cloud/src/api apps/cloud/src/auth apps/local/src/server \
  packages/core/api/src packages/core/storage-core/src packages/core/storage-file/src \
  packages/core/storage-postgres/src packages/core/storage-drizzle/src \
  packages/plugins/mcp/src packages/plugins/openapi/src packages/plugins/graphql/src \
  packages/plugins/google-discovery/src packages/plugins/oauth2/src \
  packages/plugins/onepassword/src packages/plugins/workos-vault/src \
  packages/plugins/file-secrets/src packages/plugins/keychain/src \
  -type f \( -name "*.ts" -o -name "*.tsx" \) |
  rg -v '(\.test\.|\.spec\.|\.e2e\.|dist/|node_modules/|embedded-migrations\.gen\.ts|/react/)' \
  > .warden-runs/exfil-targets-focused.txt

npm exec --yes --package=@sentry/warden -- \
  warden $(tr '\n' ' ' < .warden-runs/exfil-targets-focused.txt) \
  --skill wrdn-data-exfil --fail-on off --report-on low --min-confidence low \
  --parallel 2 --log -o .warden-runs/data-exfil.jsonl
```

GitHub Actions workflow risks:

```bash
find .github -type f \( -name "*.yml" -o -name "*.yaml" \) > .warden-runs/gha-targets.txt

npm exec --yes --package=@sentry/warden -- \
  warden $(tr '\n' ' ' < .warden-runs/gha-targets.txt) \
  --skill wrdn-gha-workflows --fail-on off --report-on low --min-confidence low \
  --parallel 2 --log -o .warden-runs/gha-workflows.jsonl
```

## How to Triage

Deduplicate findings by root cause. Warden often reports the same bug at the low-level sink, wrapper, API handler, and plugin-tool entrypoint.

For each candidate:

- Trace whether input is user-controlled.
- Identify the exact sink.
- Check whether auth, scope, host allowlists, private-IP blocks, redirects, and DNS rebinding defenses exist.
- Determine what data returns to the caller: raw body, parsed fields, typed error message, timing/status oracle, or no observable data.
- State confidence and deployment caveats.

## Current Known Findings

As of the Warden pass on 2026-04-29:

- Real: authenticated SSRF in plugin/source setup URL fetching for OpenAPI, Google Discovery, GraphQL, and MCP remote endpoints.
- Real: mutable third-party GitHub Actions refs in publish/release workflows, especially `oven-sh/setup-bun@v2` and `changesets/action@v1`.
- Clean in that pass: authz scan on cloud auth/API/core API surfaces; code-execution scan on narrowed CLI/runtime/kernel/plugin sink files.

Do not claim the whole codebase is secure from those clean runs. They are scoped scanner results.
