# Executor IaC (SST)

This directory contains the production Infrastructure as Code setup for `executor/`.

It uses SST (v3) as the deployment framework and Pulumi providers/resources under the hood.

## What this manages

- Cloudflare runtime wiring for sandbox execution (via `setup:prod:cloudflare` command resource)
- Convex production env synchronization (via `setup:prod:env` command resource)
- Convex production deploy (optional command resource)
- Production doctor verification (`doctor:prod`) after apply
- Stripe catalog resources (optional): product, recurring price, webhook endpoint
- Vercel project + environment variables (optional)

WorkOS and Convex are managed as code through scripted command resources because they do not have first-class native Pulumi resource coverage in this repo workflow.

## Prerequisites

- SST CLI login/config ready for your chosen stage
- Cloudflare credentials configured for SST/Pulumi deployment backend
- Local tools available:
  - `bun`
  - `bunx convex`
  - `bunx wrangler`

## Install

From `executor/infra`:

```bash
bun install
```

## Configure

This stack resolves values in this order:

1. SST/Pulumi stage config
2. Shell env (`process.env`)
3. Existing Convex production env (`bunx convex env list --prod`) when `IAC_USE_CONVEX_ENV_DISCOVERY` is not `0`

So if your Convex production env is already populated, you only need minimal bootstrap values.

Minimal bootstrap env for baseline deploy:

```bash
# Convex API URL (if not already present in Convex prod env)
export CONVEX_URL=https://<deployment>.convex.cloud
```

If Convex prod env is empty/new, also provide WorkOS + Stripe + runtime vars (or set them via SST secrets/config before deploy).

Cloudflare auth is handled by `wrangler` when the Cloudflare setup command runs, so make sure `wrangler whoami` works in your shell.

Optional toggles (defaults shown):

```bash
export IAC_MANAGE_CLOUDFLARE_RUNTIME=true   # default true
export IAC_MANAGE_CONVEX_ENV=true           # default true
export IAC_DEPLOY_CONVEX_FUNCTIONS=true     # default true
export IAC_MANAGE_VERCEL_PROJECT=false      # default false
export IAC_MANAGE_STRIPE_CATALOG=false      # default false
```

If `IAC_MANAGE_STRIPE_CATALOG=true`, also set:

```bash
export IAC_STRIPE_UNIT_AMOUNT=2000
export IAC_STRIPE_INTERVAL=month
export IAC_STRIPE_CURRENCY=usd
```

If `IAC_MANAGE_VERCEL_PROJECT=true`, also set:

```bash
export VERCEL_API_TOKEN=<value>
export VERCEL_TEAM=<team-id-or-slug>                # optional
export VERCEL_PROJECT_NAME=executor-web             # optional
export VERCEL_GIT_REPO=owner/repo                   # optional
```

## Deploy

```bash
sst install
bun run deploy
```

From `executor/`, prefer the guided deploy runner:

```bash
# Plan only (no changes)
bun run deploy:prod

# Apply all steps
bun run deploy:prod --apply

# Apply selected steps
bun run deploy:prod --apply --only cloudflare,doctor
```

For first-time initialization of a fresh production deployment from `executor/`:

```bash
bun run setup:prod:cloudflare --deploy
bun run setup:prod:env --from-env --strict
```

## Helpful outputs

The stack returns outputs including:

- `doctorCommand`
- `stripePriceId`
- `vercelProjectId`

## Notes

- `doctor:prod` remains the final correctness gate.
- Optional billing URLs can be set as config and will be propagated to Convex env.
- If you disable a managed area (`manageVercelProject`, `manageStripeCatalog`, etc), ensure required values are supplied by config/secrets instead.
