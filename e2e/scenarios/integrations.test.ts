// Cross-target: a fresh workspace ships the built-in executor integration ready
// to use — it appears in the catalog, it cannot be removed, and it already
// contributes tools through the tools surface so an agent can start using it
// without any manual setup.
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";

const coreApi = composePluginApi([] as const);

scenario(
  "Integrations · a fresh workspace ships the built-in executor integration ready to use",
  { needs: ["api"] },
  (ctx) =>
    Effect.gen(function* () {
      ctx.rec.say(
        "Sign in as a fresh identity and verify the built-in executor integration is present " +
          "in the catalog, cannot be removed, and already exposes tools — so an agent has " +
          "something to call without any extra setup.",
      );

      const identity = yield* ctx.target.newIdentity();
      const client = yield* ctx.api.client(coreApi, identity);

      // --- Step 1: catalog lists the built-in integration ---
      ctx.rec.say(
        "Call integrations.list and locate the integration with slug 'executor' — " +
          "the built-in one that every workspace ships with.",
      );
      const integrations = yield* ctx.api.call("integrations.list", {}, client.integrations.list());

      const builtin = integrations.find((i) => i.slug === "executor");
      ctx.rec
        .expect(builtin !== undefined, "the 'executor' integration is in the catalog")
        .toBe(true);

      // --- Step 2: it is a permanent, non-removable catalog entry ---
      ctx.rec.say(
        "Confirm the built-in integration carries the 'built-in' kind and cannot be removed " +
          "— a user who deletes every manually-added integration still has it.",
      );
      ctx.rec.expect(builtin?.kind, "kind is 'built-in'").toBe("built-in");
      ctx.rec
        .expect(builtin?.canRemove, "canRemove is false — the integration is permanent")
        .toBe(false);

      // --- Step 3: it contributes tools immediately (no connection setup needed) ---
      ctx.rec.say(
        "Call tools.list and verify at least one tool has integration 'executor' — " +
          "the agent-facing core tools are available out of the box.",
      );
      const tools = yield* ctx.api.call("tools.list", {}, client.tools.list());

      const executorTools = tools.filter((t) => t.integration === "executor");
      ctx.rec
        .expect(
          executorTools.length,
          "at least one tool belongs to the executor integration without any manual setup",
        )
        .toBeGreaterThan(0);
    }),
);
