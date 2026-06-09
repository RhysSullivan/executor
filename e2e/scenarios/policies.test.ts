// Cross-target: exercise the policies CRUD surface through the typed HttpApiClient.
// Creates a policy as a fresh identity and asserts it comes back in the list.
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";

const coreApi = composePluginApi([] as const);

scenario(
  "Policies · a created policy appears in the list for the owning identity",
  { needs: ["api"] },
  (ctx) =>
    Effect.gen(function* () {
      ctx.rec.say(
        "Sign in as a fresh identity, create a policy scoped to the org owner, " +
          "then list policies and confirm the new entry is present with the expected shape.",
      );

      const identity = yield* ctx.target.newIdentity();
      const client = yield* ctx.api.client(coreApi, identity);

      ctx.rec.say('Create a policy that blocks every tool under the "policies-scn." prefix.');
      const created = yield* ctx.api.call(
        "policies.create",
        { owner: "org", pattern: "policies-scn.*", action: "block" },
        client.policies.create({
          payload: { owner: "org", pattern: "policies-scn.*", action: "block" },
        }),
      );

      ctx.rec.expect(created.owner, "owner matches what we sent").toBe("org");
      ctx.rec.expect(created.pattern, "pattern matches what we sent").toBe("policies-scn.*");
      ctx.rec.expect(created.action, "action matches what we sent").toBe("block");

      ctx.rec.say("List all policies and confirm the newly created policy is included.");
      const list = yield* ctx.api.call("policies.list", {}, client.policies.list());

      const found = list.find((p) => p.id === created.id);
      ctx.rec
        .expect(found?.id ?? "(missing)", "created policy appears in the list")
        .toBe(created.id);
      ctx.rec
        .expect(found?.pattern ?? "(missing)", "listed entry preserves the pattern")
        .toBe("policies-scn.*");
      ctx.rec
        .expect(found?.action ?? "(missing)", "listed entry preserves the action")
        .toBe("block");
    }),
);
