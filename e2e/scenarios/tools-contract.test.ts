// Cross-target: every advertised tool carries the minimal metadata an agent
// consumer needs to pick and invoke it — a non-empty address, name, and
// description. One evidence-carrying assertion over the whole catalog: a
// failure names the offending tools instead of rendering true!==true.
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";

const coreApi = composePluginApi([] as const);

scenario("Tools · every advertised tool is well-formed enough to call", { needs: ["api"] }, (ctx) =>
  Effect.gen(function* () {
    ctx.rec.say(
      "List all tools through the typed client and verify each one has the metadata an agent consumer needs: a non-empty address, name, and description.",
    );
    const identity = yield* ctx.target.newIdentity();
    const client = yield* ctx.api.client(coreApi, identity);
    const tools = yield* ctx.api.call("tools.list", {}, client.tools.list());

    ctx.rec.expect(tools.length, "the catalog advertises tools").toBeGreaterThan(0);

    const malformed = tools
      .filter((tool) => !(tool.address?.length && tool.name?.length && tool.description?.length))
      .map((tool) => tool.address || tool.name || "(unidentifiable tool)");
    ctx.rec
      .expect(
        malformed.join(", ") || "none",
        `of ${tools.length} tools, those missing an address, name, or description`,
      )
      .toBe("none");
  }),
);
