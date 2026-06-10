// Cross-target: policies CRUD through the typed HttpApiClient — a created
// policy comes back in the list with the shape that was sent.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";

const coreApi = composePluginApi([] as const);

scenario(
  "Policies · a created policy appears in the list for the owning identity",
  { needs: ["api"] },
  (ctx) =>
    Effect.gen(function* () {
      const identity = yield* ctx.target.newIdentity();
      const client = yield* ctx.api.client(coreApi, identity);

      const created = yield* client.policies.create({
        payload: { owner: "org", pattern: "policies-scn.*", action: "block" },
      });
      expect(created.owner).toBe("org");
      expect(created.pattern).toBe("policies-scn.*");
      expect(created.action).toBe("block");

      const list = yield* client.policies.list();
      const found = list.find((p) => p.id === created.id);
      expect(found, "created policy appears in the list").toBeDefined();
      expect(found?.pattern, "listed entry preserves the pattern").toBe("policies-scn.*");
      expect(found?.action, "listed entry preserves the action").toBe("block");
    }),
);
