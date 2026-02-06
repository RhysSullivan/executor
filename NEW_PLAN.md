# OpenAssistant — Architecture Plan

## What This Is

An AI assistant that takes natural language prompts and executes them as typed TypeScript code against registered tools. Unlike CLI-based agents (OpenClaw, ClawdBot), the agent generates TypeScript code rather than shell commands, giving precise control over what gets approved, what runs, and what the agent can access.

## Example Prompts

| Prompt | Task Type | Duration |
|---|---|---|
| "On AnswerOverflow/AnswerOverflow, close all issues older than 30 days" | One-shot | Seconds/minutes |
| "Every day at 9am check if my site has hit 10M visitors with PostHog and if it has let me know" | Recurring + conditional exit | Days/weeks |
| "Tell me how many people have subscribed every day at 5pm" | Recurring, no exit | Forever |
| "When I get an email, check if it's spam and if it is delete it" | Event-triggered | Forever |

## Architecture

```
                     Clients (pull events, push decisions)
                     ──────────────────────────────────────
                     Discord bot    Web UI    CLI    Slack
                         │            │        │       │
                         └────────────┴────────┴───────┘
                                      │
                              Event stream (SSE / WS)
                              + REST for decisions
                                      │
                     Server (gateway)
                     ──────────────────────────────────────
                     Bun.serve()
                     ├── SSE event stream per task
                     ├── REST API (/api/tasks, /api/approvals, /api/hooks)
                     ├── Workflow .well-known routes (durability)
                     ├── Agent loop (Claude + codemode runner)
                     ├── Tool plugins (hand-written + MCP + OpenAPI)
                     └── Persistence (bun:sqlite for MVP)
```

### Key Principle: Server Emits Events, Clients Subscribe

The server never POSTs to clients. Instead:
1. Every task produces a stream of `TaskEvent`s (persisted, resumable)
2. Clients subscribe via SSE/WebSocket/polling
3. When a tool needs approval, the server emits an `approval_request` event
4. Any client renders approval UI and POSTs the decision to `POST /api/approvals/:callId`
5. The server picks up the decision and continues execution

This is client-agnostic. Discord, web, CLI — they all implement the same protocol.

## Execution Sandbox

LLM-generated code runs in a `node:vm` sandbox with `Object.create(null)` as the context base:

- **Allowed:** `tools` (injected), `JSON`, `Math`, `Date`, `console` (no-op)
- **Blocked:** `fetch`, `process`, `Bun`, `require`, `import()`, all Node/Bun APIs
- **Constructor chain escape:** Safe — returns the sandbox global which has nothing dangerous
- **Prototype pollution:** Stays in sandbox, does not leak to host
- **Execution timeout:** `vm.runInContext` `timeout` option
- **Memory limits:** Not controllable with `node:vm` (would need rquickjs, deferred to post-MVP)

Tool functions are wrapped so `toString()` doesn't leak source code.

## Durability — Vercel Workflow

[Vercel Workflow DevKit](https://github.com/vercel/workflow) handles:
- **Durable scheduling:** `sleep("1 day")` suspends the workflow, consumes zero compute, survives restarts
- **Durable event waiting:** `createHook()` + `for await` loop for webhook-triggered tasks
- **Crash recovery:** Workflow state is persisted; on restart, replays from the event log
- **Observability:** Every workflow run, every step, every retry is traced

### Three Workflow Templates (compile-time)

All workflows are generic. The `prompt` argument (interpreted by Claude at runtime) determines behavior.

```ts
// workflows/one-shot.ts — "close all stale issues"
export async function oneShotWorkflow(prompt, requesterId, channelId, taskId) {
  "use workflow";
  const result = await runAgentTurn(prompt, requesterId, channelId, taskId);
  return result;
}

// workflows/recurring.ts — "every day at 9am check X"
export async function recurringWorkflow(prompt, requesterId, channelId, taskId, intervalMs) {
  "use workflow";
  while (true) {
    await sleep(intervalMs);
    await runAgentTurn(prompt, requesterId, channelId, taskId);
  }
}

// workflows/event-triggered.ts — "when I get an email, do X"
export async function eventTriggeredWorkflow(prompt, requesterId, channelId, taskId, hookToken) {
  "use workflow";
  const hook = createHook<Record<string, unknown>>({ token: hookToken });
  for await (const payload of hook) {
    const enrichedPrompt = `${prompt}\n\nEvent data:\n${JSON.stringify(payload, null, 2)}`;
    await runAgentTurn(enrichedPrompt, requesterId, channelId, taskId);
  }
}
```

### The Shared Step

```ts
async function runAgentTurn(prompt, requesterId, channelId, taskId) {
  "use step";
  // Full runtime access here — this is where the agent loop runs
  // Creates runner, calls Claude, executes code, collects receipts
  // Emits TaskEvents to the stream (including approval_request)
  // Polls for approval decisions from clients
}
```

## Tool System

### defineTool API

```ts
import { z } from "zod";

defineTool({
  description: "Close a GitHub issue",
  approval: "required",
  args: z.object({
    owner: z.string(),
    repo: z.string(),
    issueNumber: z.number(),
  }),
  returns: z.object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
  }),
  run: async (input) => { ... },
  formatApproval: (input) => ({
    title: `Close ${input.owner}/${input.repo}#${input.issueNumber}`,
  }),
});
```

- `args` (Zod schema) → validates input at invocation + generates TypeScript declarations for typechecker + generates LLM prompt guidance
- `returns` (Zod schema) → generates TypeScript return type
- `description` → LLM prompt guidance
- `approval: "auto" | "required"` → determines approval flow
- `run` → plain `async` function (not Effect in the public API)
- `formatApproval` → optional, provides rich approval presentation

### Three Tool Sources

All produce the same `ToolTree` + TypeScript declarations. The runner doesn't know the difference.

**1. Hand-written plugins**
```ts
export const githubTools = {
  github: {
    issues: {
      close: defineTool({ ... }),
    }
  }
};
```

**2. MCP servers** (auto-generated at startup)
```ts
// Config: { type: "mcp", name: "answeroverflow", url: "https://www.answeroverflow.com/mcp" }
// → Introspects tools/list
// → Generates: tools.answeroverflow.search_answeroverflow({ query })
// → Each tool wraps client.callTool(name, input)
```

**3. OpenAPI specs** (auto-generated at startup)
```ts
// Config: { type: "openapi", name: "fastspring", spec: "https://...", auth: { ... } }
// → Parses spec, groups by tag
// → GET → approval: "auto", POST/PUT/DELETE → approval: "required"
// → Generates: tools.fastspring.accounts.get({ account_id })
```

### Tool Source Config

```ts
const toolSources = [
  createGitHubPlugin(),
  { type: "mcp", name: "answeroverflow", url: "https://www.answeroverflow.com/mcp" },
  { type: "openapi", name: "fastspring", spec: "https://...", auth: { type: "basic", credentials: "FASTSPRING_CREDENTIALS" } },
];
```

## Approval Flow

### One-shot tasks (user is active in conversation)

1. Agent generates code that calls `tools.github.issues.close(...)`
2. Runner hits the approval gate for `approval: "required"` tools
3. Runner emits `{ type: "approval_request", id, toolPath, preview }` to the task event stream
4. Runner polls `getApprovalDecision(callId)` in a loop
5. Client (Discord/web/CLI) sees the event, renders approval UI
6. User clicks Approve → client POSTs to `POST /api/approvals/:callId`
7. Decision is written to DB
8. Runner's poll picks it up, execution continues

### Background tasks (recurring/event-triggered, no active conversation)

Same flow, but the client sends a proactive DM/notification with approval buttons. The user approves asynchronously.

### Batch approval (future enhancement)

For tasks that need many approvals (close 15 issues), a batch approval mode: show all proposed actions upfront, user approves once.

## Task Event Stream

Every task run produces events. Clients subscribe and render them however they want.

```ts
type TaskEvent =
  | { type: "status"; message: string }
  | { type: "code_generated"; code: string }
  | { type: "approval_request"; id: string; toolPath: string; input: unknown; preview: ApprovalPresentation }
  | { type: "approval_resolved"; id: string; decision: "approved" | "denied" }
  | { type: "tool_result"; id: string; toolPath: string; status: "succeeded" | "failed" | "denied"; preview?: string }
  | { type: "agent_message"; text: string }
  | { type: "error"; error: string }
  | { type: "completed" }
```

## Task Management

The agent has task management tools (so the user speaks natural language):

```
tools.tasks.list()                    → active tasks for this user
tools.tasks.createRecurring(...)      → starts a recurring workflow
tools.tasks.createEventTrigger(...)   → starts an event-triggered workflow
tools.tasks.cancel({ taskId })        → cancels a workflow run
tools.tasks.history({ taskId })       → recent events from a task's stream
```

## Persistence

**bun:sqlite** for MVP. Single file, zero ops. Used for:
- Workflow world (adapter needed, or use Workflow's local filesystem world)
- Approval decisions (polling table)
- Task registry (what tasks exist, who owns them)
- Auth credentials (env vars for MVP, DB profiles later)

## Agent Loop

1. Build system prompt from tool descriptions + type declarations + task context
2. Call Claude with the prompt and the `run_code` tool
3. Claude responds with `run_code({ code: "..." })`
4. Typecheck the code against generated TypeScript declarations
5. If typecheck fails: feed error back to Claude, retry (up to 3 times)
6. Execute code in `node:vm` sandbox
7. Collect receipts from all tool calls
8. Feed receipts back to Claude
9. Claude may call `run_code` again, or produce final text response
10. Emit `agent_message` event to the stream

## Effect Usage

Effect is used throughout the codebase, properly:
- **Services + Layers** for dependency injection (database, config, clients)
- **Tagged errors** for typed error handling
- **Tracing spans** for observability
- **Fibers** where concurrency is needed

The public `defineTool` API uses plain `async` functions — Effect is an internal implementation detail, not exposed to tool authors or the sandbox.

## Server Routes

```
POST   /.well-known/workflow/v1/flow          Workflow flow handler
POST   /.well-known/workflow/v1/step          Workflow step handler
*      /.well-known/workflow/v1/webhook/:token Workflow webhook handler

POST   /api/tasks                              Create a new task
GET    /api/tasks                              List tasks for a user
GET    /api/tasks/:id                          Get task status
GET    /api/tasks/:id/events                   SSE stream of TaskEvents
POST   /api/tasks/:id/cancel                   Cancel a task

POST   /api/approvals/:callId                  Resolve an approval decision

POST   /api/hooks/:token                       Webhook ingestion (external services POST here)
```

## Monorepo Layout

```
apps/
  server/                    Bun.serve() — the brain
    index.ts                 Routes: REST + Workflow + SSE + webhooks
    workflows/
      one-shot.ts            "use workflow"
      recurring.ts           "use workflow"
      event-triggered.ts     "use workflow"
      steps.ts               "use step" — shared (runAgentTurn, notifyUser)

  bot/                       Discord client
    index.ts                 discord.js, subscribes to event streams
    views/                   React components via Reacord

packages/
  core/
    tools.ts                 defineTool, ToolTree, ToolCallReceipt types
    runner.ts                node:vm sandbox execution
    typechecker.ts           TypeScript type checking (auto-gen from Zod)
    agent.ts                 Agent loop (Claude + run_code + retries)
    events.ts                TaskEvent types
    approval.ts              Approval types + logic

  tool-gen/
    mcp.ts                   MCP server introspection → ToolTree
    openapi.ts               OpenAPI spec parsing → ToolTree
    type-gen.ts              Zod schema → TypeScript declaration strings

  reacord/                   (existing) React reconciler for Discord
```

## Build Order

1. **packages/core** — defineTool, ToolTree, runner (node:vm), typechecker, agent loop, TaskEvent types. Tested with real Claude calls.
2. **packages/tool-gen** — MCP + OpenAPI generation. Uses existing parsers (@modelcontextprotocol/sdk, swagger-parser).
3. **apps/server** — Bun.serve + Workflow integration + REST API + SSE streams.
4. **apps/bot** — Discord client consuming event streams.

## Testing

Real tests, no mocks. Claude calls use Claude Max credentials.

- **Unit tests:** Runner executes code in sandbox, collects receipts. Tool definitions validate with Zod. Typechecker catches bad code.
- **Integration tests:** Agent loop generates and executes code for simple tasks. Tool-gen produces correct ToolTree from MCP/OpenAPI specs.
- **E2E tests:** Full workflow: create task → subscribe to events → approve → get results.

## What's Deferred (post-MVP)

- Hard memory limits (rquickjs)
- Credential broker / ephemeral tokens
- Batch approval UX
- Ops web UI
- CLI client
- Plugin discovery from convention directories
- Auto-compaction for long conversation contexts
