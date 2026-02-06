# OpenAssistant: High-Level Architecture Plan

## 1) Product Thesis

Build a personal agent platform with OpenClaw-like flexibility, but with a strict trust model:

- No free-form shell as the default execution surface.
- Actions run through typed TypeScript clients with explicit capability boundaries.
- Destructive operations require approval by policy.
- Every claim from the model is backed by auditable execution evidence.

## 2) Core Principles

- Capability-first execution: the model can only call registered client methods.
- Policy as code: permissions, approval gates, and risk tiers are explicit config.
- Evidence over narration: the assistant response is generated from execution receipts.
- Durable automation: reminders/schedules are owned by scheduler state, not model memory.
- Portable runtime: Bun + TypeScript monorepo, predictable local and remote deploy paths.

## 3) What To Keep vs Replace

Keep from OpenClaw:

- Gateway + session architecture.
- Multi-client model (Discord, CLI, web, device nodes).
- Event stream for system and execution updates.
- Cron/heartbeat concept for always-on automation.

Replace:

- Bash-first action model.
- Implicit tool use visibility.
- Broad account credentials without fine-grained scope boundaries.

## 4) System Shape

Control plane:

- `gateway`: authoritative orchestration service.
- `policy-engine`: evaluates if a call is auto-allowed, approval-required, or denied.
- `approval-service`: manages pending approvals, TTL, decisions, audit trail.
- `scheduler`: durable jobs, reminders, retries, dead-letter.
- `event-log`: append-only event stream and query API for UI and audits.

Execution plane:

- `code-runner`: executes generated TypeScript in sandboxed runtime.
- `client-runtime`: injects typed clients into script context.
- `tool-host-local`: local client execution with local creds.
- `tool-host-remote`: remote tool execution with scoped ephemeral creds.

Interaction plane:

- `chat-clients`: Discord/web/CLI channels.
- `ops-ui`: approvals, receipts, schedules, policy edits, run timelines.

## 5) Execution Model (Codemode + Typed Clients)

Single model-facing tool:

- `run_code({ code, intent, sessionId })`.

Injected runtime in script:

- `clients.<integration>.<method>(input)`
- `Result<T, E>` return style.
- No `child_process`, no `fetch` directly, no unrestricted FS/network.

Example shape (conceptual):

```ts
const result = await clients.calendar.updateEvent({ id, patch })
if (result.isError()) {
  return Result.err(result.error)
}
return Result.ok(result.value)
```

Outcome:

- OpenClaw-level composability.
- MCP/tool-call-style control boundaries.
- Better determinism and auditability than shell command synthesis.

## 6) Capability and Permission Model

Permission unit:

- `integration.resource.action` (example: `vercel.firewall.rule.delete`).

Client method metadata:

- `risk`: `read | write | destructive | privileged`.
- `autoRun`: boolean default.
- `requiresApproval`: optional override.
- `idempotent`: boolean.
- `allowedScopes`: account/project/environment constraints.

Policy decision:

- `allow` if method scope and risk pass policy.
- `ask` if action is sensitive or outside auto-run envelope.
- `deny` if forbidden by capability map.

## 7) Approval Flow

Request path:

1. Script calls client method.
2. Runtime asks policy engine.
3. If `ask`, execution pauses with `ApprovalPending` receipt.
4. Approval prompt sent to origin chat + optional ops targets.
5. Approver chooses `allow-once`, `allow-window`, `deny`, or `allow-and-policy-update`.
6. Execution resumes or returns denial as value.

Key UX requirements:

- User always sees which exact method and arguments are pending.
- Expiration and timeout reason are explicit.
- Run status updates: `pending`, `running`, `completed`, `denied`, `failed`.

## 8) Receipts and Anti-Lying Guarantees

Every side-effectful call emits immutable receipts:

- `call.requested`
- `call.approved|call.denied`
- `call.started`
- `call.finished|call.failed`

Assistant response rule:

- For external actions, summarize from receipts only.
- If no receipt exists, assistant must state action was not completed.

UI requirement:

- Inline "did it really run?" evidence panel per assistant answer.

## 9) Scheduler and Reminders

Scheduler owns state, not the LLM:

- Reminders become scheduler jobs with a stable `jobId`.
- Jobs are persisted in a durable store.
- Delivery attempts and outcomes are logged as receipts.
- If delivery target fails, retries/backoff are deterministic.

Contract:

- "Remind me tomorrow at 9am" returns a created job receipt immediately.
- User can query, edit, pause, or delete by `jobId`.

## 10) OpenAPI to Client Pipeline

Goal:

- Convert API specs into safe typed clients and policy metadata.

Pipeline:

1. Ingest OpenAPI spec.
2. Generate TypeScript client methods.
3. Classify methods by risk heuristics and optional provider-specific rules.
4. Emit package with runtime validators + method metadata.
5. Register integration in gateway catalog.

Outputs per integration package:

- `client.ts` typed method surface.
- `schema.ts` input/output validation.
- `policy.ts` default risk/approval metadata.
- `README.md` capability list and example usage.

## 11) Remote Tools and Ephemeral Credentials

Remote execution model:

- Gateway requests short-lived scoped token from credential broker.
- Tool host executes only permitted client methods.
- Token TTL and scope are embedded in receipt for audit.

Security baseline:

- No long-lived broad API keys in model runtime.
- Per-tool/per-method scope limits.
- Revocation and rotation built into credential broker.

## 12) Monorepo Layout (Bun)

```text
apps/
  gateway/
  ops-ui/
  discord-client/
  cli/
packages/
  sdk/
  runner/
  policy-engine/
  approval-service/
  scheduler/
  event-log/
  receipt-model/
  integration-registry/
  integration-openapi-gen/
  integrations/
    posthog/
    github/
    vercel/
    gcal/
  transport-ws/
  transport-http/
  shared-types/
```

## 13) Data Model (High-Level)

Core entities:

- `Session`
- `Run`
- `Script`
- `ToolCall`
- `ApprovalRequest`
- `Receipt`
- `Job`
- `CredentialLease`
- `PolicySnapshot`

Strong recommendation:

- Event-sourced append log for execution and approvals.
- Materialized read views for chat timeline and dashboard.

## 14) MVP Scope (Phase 1)

Include:

- Gateway + WS event stream.
- Code runner with sandboxed TS execution.
- Typed integration runtime (manual first: GitHub + Calendar + PostHog).
- Policy engine with `read/write/destructive`.
- Approval UI in Discord + lightweight web panel.
- Scheduler with reminders and hourly monitors.
- Receipt-backed final answer generation.

Exclude initially:

- General bash execution.
- Arbitrary plugin execution from untrusted sources.
- Complex multi-tenant org model.

## 15) Phase Plan

Phase A: Foundation

- Monorepo skeleton, shared types, event bus, gateway sessions.
- Runner sandbox and `run_code` API.

Phase B: Trust Layer

- Policy engine, approvals, receipt model, auditable run timeline.

Phase C: Integrations

- Manual clients + openapi codegen pipeline.
- Scoped credentials and remote tool host.

Phase D: Automation

- Scheduler, durable reminders, monitors, retry semantics.

Phase E: UX

- Discord + web ops surface for approvals and evidence links.

## 16) Key Risks and Mitigations

Risk: Model-generated TS can still be unsafe.
Mitigation: hard sandbox + no direct network/process APIs + capability-injected clients only.

Risk: Approval fatigue.
Mitigation: risk tiers, approval windows, per-integration trusted scopes.

Risk: "Says it did it" regressions.
Mitigation: receipt-backed response contract + explicit uncertainty language.

Risk: Credential sprawl.
Mitigation: brokered ephemeral tokens and strict method-level scopes.

## 17) First Technical Decision Set

Decide now:

- Bun runtime boundary for runner isolation.
- Storage stack for append log + views.
- Event transport protocol (WS-first, HTTP fallback).
- Policy DSL format (JSON policy vs TS policy modules).
- Credential broker interface and lease format.

## 18) Success Criteria

You should be able to do all of the following with evidence:

- "Monitor PostHog and ping me at 10M" (job created, triggered, delivered).
- "Check Vercel anomaly email and advise" (reads logged, recommendation traceable).
- "Change firewall rule" (approval prompted, approved actor recorded, call receipt linked).
- "Remind me tomorrow at 9" (deterministic scheduler receipt, guaranteed delivery attempts).
