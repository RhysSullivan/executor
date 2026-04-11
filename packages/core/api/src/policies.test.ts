import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { createExecutor, makeTestConfig } from "@executor/sdk";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "./server";
import { ExecutorApi } from "./api";

const engineStub = {
  execute: async () => ({ result: null, logs: [] }),
  executeWithPause: async () => ({
    status: "completed" as const,
    result: { result: null, logs: [] },
  }),
  resume: async () => null,
  getDescription: async () => "",
};

const createHandler = async () => {
  const executor = await Effect.runPromise(createExecutor(makeTestConfig()));

  return HttpApiBuilder.toWebHandler(
    HttpApiBuilder.api(ExecutorApi).pipe(
      Layer.provide(CoreHandlers),
      Layer.provide(Layer.succeed(ExecutorService, executor)),
      Layer.provide(Layer.succeed(ExecutionEngineService, engineStub as any)),
      Layer.provideMerge(HttpServer.layerContext),
      Layer.provideMerge(HttpApiBuilder.Router.Live),
      Layer.provideMerge(HttpApiBuilder.Middleware.layer),
    ),
  );
};

describe("PoliciesHandlers", () => {
  it("round-trips create, list, get, update, and remove", async () => {
    const web = await createHandler();

    try {
      const createResponse = await web.handler(
        new Request("http://localhost/scopes/test-scope/policies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            toolPattern: "openapi.stripe.*",
            effect: "allow",
            approvalMode: "required",
            priority: 2,
            enabled: true,
          }),
        }),
      );
      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as { id: string; toolPattern: string };
      expect(created.toolPattern).toBe("openapi.stripe.*");

      const listResponse = await web.handler(
        new Request("http://localhost/scopes/test-scope/policies", { method: "GET" }),
      );
      expect(listResponse.status).toBe(200);
      const listed = (await listResponse.json()) as Array<{ id: string }>;
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe(created.id);

      const getResponse = await web.handler(
        new Request(`http://localhost/scopes/test-scope/policies/${created.id}`, { method: "GET" }),
      );
      expect(getResponse.status).toBe(200);
      const loaded = (await getResponse.json()) as { id: string };
      expect(loaded.id).toBe(created.id);

      const updateResponse = await web.handler(
        new Request(`http://localhost/scopes/test-scope/policies/${created.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            approvalMode: "auto",
            priority: 5,
          }),
        }),
      );
      expect(updateResponse.status).toBe(200);
      const updated = (await updateResponse.json()) as {
        approvalMode: string;
        priority: number;
      };
      expect(updated.approvalMode).toBe("auto");
      expect(updated.priority).toBe(5);

      const removeResponse = await web.handler(
        new Request(`http://localhost/scopes/test-scope/policies/${created.id}`, {
          method: "DELETE",
        }),
      );
      expect(removeResponse.status).toBe(200);
      expect(await removeResponse.json()).toEqual({ removed: true });
    } finally {
      await web.dispose();
    }
  });

  it("returns 400 for an empty update payload", async () => {
    const web = await createHandler();

    try {
      const createResponse = await web.handler(
        new Request("http://localhost/scopes/test-scope/policies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            toolPattern: "openapi.stripe.*",
            effect: "allow",
            approvalMode: "required",
            priority: 2,
            enabled: true,
          }),
        }),
      );
      const created = (await createResponse.json()) as { id: string };

      const response = await web.handler(
        new Request(`http://localhost/scopes/test-scope/policies/${created.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        _tag: "InvalidPolicyPayloadError",
        message: "update payload must include at least one field",
      });
    } finally {
      await web.dispose();
    }
  });
});
