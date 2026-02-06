# OpenAssistant MVP: Primitive-First Plan

## Goal

Ship an MVP that is:

- Small enough to build fast.
- Safe enough to trust.
- Extensible enough to add integrations later.

Core rule: the system does not guarantee outcomes, it guarantees evidence of attempted/completed calls to integrations.

## Non-Goals (MVP)

- No default reminder/calendar system.
- No giant plugin marketplace.
- No many-package architecture upfront.
- No bash-first execution path.

## MVP Building Blocks (Primitives)

### 1) `Run Primitive`

Executes model-generated TypeScript in a sandbox with a single injected surface:

- `tools.<integration>.<method>(input): Result<ok, err>`

No direct shell/network/process access from model code.

### 2) `Tool Contract Primitive`

Each tool method has metadata:

- `id`: `integration.resource.action`
- `risk`: `read | write | destructive`
- `requiresApproval`: boolean or policy-driven
- `schema`: input/output validation

This is the capability boundary.

### 3) `Policy + Approval Primitive`

Policy returns one of:

- `allow`
- `ask`
- `deny`

If `ask`, run pauses until explicit decision (`allow-once`, `deny`, optional short-lived window).

### 4) `Receipt Primitive` (Proof of Work)

Append-only receipts for every tool interaction:

- `tool.call.requested`
- `tool.call.approved | tool.call.denied` (if applicable)
- `tool.call.started`
- `tool.call.succeeded | tool.call.failed`

These receipts are the source of truth for what actually happened.

### 5) `Relevant Tool Activity Primitive` (Evidence Surface)

The gateway derives a system-generated summary of relevant tool activity from receipts.

- This summary is passed to the model for final response generation.
- This same summary is surfaced to the user/client.
- The summary is filtered to relevant calls, not a full noisy log.

Summary fields (MVP):

- `toolId`
- `status` (`succeeded | failed | denied | pending`)
- `approval` (`required/decision` when applicable)
- `when` (timestamp)
- `receiptRef` (id/link for audit trail)

Relevance rules (MVP):

- Include calls from the current run.
- Always include failed/denied/pending calls.
- Include side-effectful calls (`write | destructive`).
- Optionally include key reads used to justify decisions.

This is the anti-lying mechanism: responses are grounded in gateway-produced evidence summaries, not free model claims.

### 6) `Response Grounding Primitive`

Assistant action statements should be based on the relevant tool activity summary.

If no successful call exists for an intended action, response must say it could not verify completion.

### 7) `Tool Workspace Primitive` (User-Authored Tools)

Users (or the agent) can create tools in an assistant workspace directory.

- Tool files are TypeScript modules using a shared `defineTool()` contract.
- Each tool exports metadata, schema, and handler.
- Gateway discovers and reloads tools from the workspace on file change or explicit reload.

This enables "write your own tools" without touching core runtime code.

### 8) `Auth Profile Primitive` (Claude Max Support)

MVP supports Anthropic Claude Max the same way OpenClaw does:

- User runs `claude setup-token` outside the app.
- User pastes token into OpenAssistant auth command.
- Token is stored as an auth profile of `type: "token"` for provider `anthropic`.
- Model runs resolve credentials from profile order first, then env fallback.

This avoids coupling to Claude CLI internals while still leveraging Claude Max plan auth.

## Minimal Repository Shape

Keep it simple first:

```text
apps/
  gateway/         # chat loop, run orchestration, ws/http API
  discord-client/  # primary MVP chat + approval interaction surface
packages/
  core/            # shared types, Result, receipt models, policy types
  runtime/         # TS runner sandbox + tool bridge
  sdk/             # defineTool(), integration client wrappers
integrations/
  example-calendar/
  example-posthog/
```

Only 3 packages. Add more only when pain is real.

Notes:

- `ops` means operator surface (approvals + receipts), not necessarily a web app.
- MVP should use Discord as the operator surface first to avoid UI overhead.
- Optional web ops UI can be phase 2.

## Data Model (MVP)

- `Run { id, sessionId, status, startedAt, endedAt }`
- `ToolCall { id, runId, toolId, inputHash, risk }`
- `ApprovalRequest { id, toolCallId, status, decidedBy, decidedAt }`
- `Receipt { id, runId, toolCallId?, type, ts, payload }`
- `RelevantToolActivity { runId, items[] }` (derived view from receipts)
- `AuthProfile { id, provider, type, secretRef, expiresAt?, lastUsedAt?, cooldownUntil? }`

Use one append-only receipts table/log first. Build read views later.

## How “Reminder Truthfulness” Works Without Built-In Reminder System

User says: “Remind me tomorrow at 9.”

MVP behavior:

1. Model chooses an integration tool (calendar/todo/automation/etc).
2. Runtime executes that tool call.
3. Receipt(s) are written.
4. Gateway derives relevant tool activity summary.
5. Assistant response + client surface that summary.

So:

- If scheduling tool call is `succeeded`, response can say it was scheduled and show that tool call.
- If scheduling call is `failed/denied/pending`, response should say that and surface the relevant call.

No assumption about which reminder provider is used.

## User-Authored Tool Flow (MVP)

Assistant workspace (example):

```text
~/.config/openassistant/
  tools/
    posthog/
      client.ts
      tools.ts
```

Tool definition shape (conceptual):

```ts
export const checkVisitors = defineTool({
  id: "posthog.analytics.getVisitors",
  risk: "read",
  input: z.object({ projectId: z.string(), website: z.string() }),
  policy: { default: "allow" },
  handler: async (input, ctx) => { /* call posthog */ },
})

export const createThresholdMonitor = defineTool({
  id: "posthog.monitor.createThresholdJob",
  risk: "write",
  input: z.object({
    website: z.string(),
    threshold: z.number(),
    cron: z.string(), // e.g. daily 9am
  }),
  policy: { default: "ask" },
  handler: async (input, ctx) => { /* call scheduler or remote endpoint */ },
})
```

Runtime flow:

1. Prompt asks for PostHog threshold monitor.
2. Agent writes/updates PostHog tool module in workspace.
3. Gateway reloads tool registry.
4. Run uses newly available tool methods.
5. Every call emits receipts.
6. Gateway computes relevant tool activity.
7. Assistant + client surface relevant tool activity.

What is guaranteed:

- Proof that the tool endpoint was called and what happened.

What is not guaranteed by core:

- Which reminder/scheduler provider is used internally by that tool.

## Claude Max Compatibility (OpenClaw Pattern)

### Storage

Auth store file (example):

```text
~/.config/openassistant/auth-profiles.json
```

Credential shape:

```ts
type AuthCredential =
  | { type: "api_key"; provider: string; key: string }
  | { type: "token"; provider: string; token: string; expires?: number }
  | { type: "oauth"; provider: string; access: string; refresh: string; expires: number }
```

For Claude Max setup-token:

- write profile like `anthropic:manual` with `type: "token"`.
- mark config profile mode as `token` (oauth-compatible for provider auth logic).

### CLI Surface (MVP)

```bash
openassistant auth anthropic setup-token
```

Flow:

1. Prompt user to run `claude setup-token`.
2. Validate token prefix/shape.
3. Save token profile in auth store.
4. Set profile as preferred for Anthropic provider in config/order.

### Provider Auth Resolution

Resolution order:

1. Explicit profile override (if run/session pinned).
2. Provider profile order from config/store.
3. Env fallback (`ANTHROPIC_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY`).
4. Error with actionable re-auth instructions.

### Runtime Behavior

At run start:

- Resolve provider auth once for selected model/provider.
- Inject credential into model client adapter.

On provider failures (rate-limit/auth/billing):

- mark profile failure/cooldown.
- rotate to next profile when available.
- emit receipt/event that profile rotation occurred.

This gives Claude Max usability plus long-term multi-profile resilience.

## Extensibility Path

New integration = add one folder under `integrations/*` implementing:

- Tool contract metadata
- Runtime client wrapper
- Schema validation

No core refactor needed if primitives are stable.

## MVP Scope Checklist

- Sandbox run primitive working.
- Tool contract registry working.
- Workspace tool discovery/reload working.
- Policy/approval gate working.
- Receipt log working and queryable.
- Relevant tool activity summary derivation working.
- Response grounding from relevant tool activity working.
- Anthropic setup-token auth flow working (`claude setup-token` paste path).
- Provider auth resolver supports profile order + env fallback.
- Discord client handles chat + approvals + receipt links.
- 2-3 integrations to prove composability.

## Suggested Order (Build Sequence)

1. `core`: types + receipt/event schema + policy decision enums.
2. `runtime`: sandbox executor + injected tool bridge.
3. `gateway`: run orchestration + tool registry + persistence + evidence summarization.
4. `discord-client`: chat loop + approve/deny actions + receipt viewing links.
5. `integrations`: add calendar/posthog/github as examples.

## Success Criteria

You can reliably demonstrate:

- A destructive action pauses for approval and logs full receipt trail.
- A non-destructive read auto-runs and logs receipt trail.
- Assistant response includes relevant tool activity for claims it makes.
- Assistant cannot claim tool success when relevant activity has no success state.
- A reminder-style request is only “done” when an integration success receipt exists.
