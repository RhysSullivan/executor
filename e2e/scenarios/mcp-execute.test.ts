// Cross-target: the MCP surface — connect with fully headless OAuth (DCR →
// consent → code → token) and run code in the sandbox, exactly as an MCP
// client (Claude, Cursor, …) would.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";

scenario("MCP · OAuth connect, then execute code in the sandbox", { needs: ["mcp-oauth"] }, (ctx) =>
  Effect.gen(function* () {
    const identity = yield* ctx.target.newIdentity();
    const session = ctx.mcp.session(identity);

    const tools = yield* session.listTools();
    expect(tools, "the execute tool is advertised").toContain("execute");

    const result = yield* session.call("execute", { code: "return 6 * 7;" });
    expect(result.text, "the sandbox returns the value").toBe("42");
  }),
);
