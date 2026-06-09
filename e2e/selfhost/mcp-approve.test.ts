// Selfhost-only: an execution that triggers an approval gate pauses, then
// resumes successfully after the model calls `resume` with action "accept".
//
// Mechanism: create a `require_approval` policy scoped to the tool
// `executor.coreTools.policies.list` via the typed HTTP API, then execute
// code over MCP that calls that tool. The execution engine hits the
// `enforceApproval` path and returns a paused result with an `executionId`.
// `session.approvePaused()` parses the id and calls the `resume` MCP tool
// with action "accept". We assert the resumed result is a completed execution
// that contains the connections list.
//
// The policy is deleted in a `finally`-equivalent step so the shared selfhost
// instance is not permanently affected.
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";

const coreApi = composePluginApi([] as const);

// The static tool address (fqid) for the coreTools `policies.list` tool as
// mounted under the executor source:
//   mountedSource.id = "executor"
//   mountedTool.name = "coreTools.policies.list"
//   fqid = "executor.coreTools.policies.list"
const APPROVAL_TARGET_TOOL = "executor.coreTools.policies.list";

// The sandbox code calls the policies.list tool which is protected by the
// policy we create above. The execution will pause awaiting approval.
const EXECUTE_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

scenario("MCP · a paused execution resumes after human approval", { needs: ["mcp-oauth"] }, (ctx) =>
  Effect.gen(function* () {
    ctx.rec.say(
      "Create a require_approval policy for a built-in tool, then execute code over MCP " +
        "that calls it. The execution must pause with an executionId. After calling " +
        "approvePaused(), the execution resumes and returns a completed result.",
    );

    const identity = yield* ctx.target.newIdentity();
    const client = yield* ctx.api.client(coreApi, identity);

    // ------------------------------------------------------------------
    // Step 1: set up the approval gate via the HTTP API.
    // ------------------------------------------------------------------
    ctx.rec.say(
      `Create a require_approval policy for ${APPROVAL_TARGET_TOOL} so the MCP execution pauses.`,
    );
    const policy = yield* ctx.api.call(
      "policies.create",
      { owner: "org", pattern: APPROVAL_TARGET_TOOL, action: "require_approval" },
      client.policies.create({
        payload: {
          owner: "org",
          pattern: APPROVAL_TARGET_TOOL,
          action: "require_approval",
        },
      }),
    );

    ctx.rec
      .expect(policy.action, "policy was created with require_approval")
      .toBe("require_approval");
    ctx.rec.expect(policy.pattern, "policy pattern targets our tool").toBe(APPROVAL_TARGET_TOOL);

    // ------------------------------------------------------------------
    // Step 2: execute code that calls the approval-gated tool.
    // ------------------------------------------------------------------
    ctx.rec.say(
      "Call `execute` over MCP with code that invokes the approval-gated tool; " +
        "the engine must return a paused result with executionId.",
    );
    const session = ctx.mcp.session(identity);

    // Warm up the MCP session before the gated call so the OAuth handshake
    // does not race with the policy window.
    const tools = yield* session.listTools();
    ctx.rec.expect(tools, "execute tool is present before the approval test").toContain("execute");

    const pauseResult = yield* session.call("execute", { code: EXECUTE_CODE });

    ctx.rec
      .expect(pauseResult.text, "execution paused rather than completing immediately")
      .toContain("Execution paused");

    ctx.rec
      .expect(pauseResult.text, "paused result carries the executionId for resume")
      .toContain("executionId:");

    // ------------------------------------------------------------------
    // Step 3: approve the paused execution and assert it completes.
    // ------------------------------------------------------------------
    ctx.rec.say(
      "Approve the paused execution via approvePaused(); the engine resumes " +
        "and the sandbox returns the policies list as a completed result.",
    );
    const resumeResult = yield* session.approvePaused(pauseResult.text);

    ctx.rec.expect(resumeResult.ok, "resumed execution completed without error").toBe(true);

    // The code returns the result of policies.list, which is a JSON object
    // with a `policies` array. That array now includes our newly created policy.
    ctx.rec
      .expect(resumeResult.text, "result contains the policies list returned by the sandbox")
      .toContain(APPROVAL_TARGET_TOOL);

    // ------------------------------------------------------------------
    // Step 4: clean up — delete the policy so the selfhost instance stays
    // clean for subsequent runs.
    // ------------------------------------------------------------------
    ctx.rec.say("Remove the test policy to leave the shared selfhost instance clean.");
    const removed = yield* ctx.api.call(
      "policies.remove",
      { policyId: policy.id, owner: "org" },
      client.policies.remove({
        params: { policyId: policy.id },
        payload: { owner: "org" },
      }),
    );
    ctx.rec.expect(removed.removed, "test policy was cleaned up").toBe(true);
  }),
);
