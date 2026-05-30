// ---------------------------------------------------------------------------
// Cloud app auth failure propagation
// ---------------------------------------------------------------------------
//
// Exercises the cloud HTTP API boundary:
//
//   test -> HttpApiClient -> ProtectedCloudApi -> execution engine
//        -> sandbox code -> OpenAPI tool invocation
//
// The assertion is intentionally on the final execution payload, not the
// plugin facade, so reviewers can see that model-visible tool results carry
// auth guidance instead of an opaque internal tool error.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { ScopeId } from "@executor-js/sdk";
import { makeOpenApiHttpApiTestAddSpecPayload } from "@executor-js/plugin-openapi/testing";

import { ProtectedCloudApi, asOrg } from "../testing/api-harness";

const PingGroup = HttpApiGroup.make("default", { topLevel: true }).add(
  HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown }),
);

const MissingAuthSourceApi = HttpApi.make("cloudAuthFailureSource").add(PingGroup);

type CloudApiShape = HttpApiClient.ForApi<typeof ProtectedCloudApi>;
type EffectSuccess<T> = T extends Effect.Effect<infer A, unknown, unknown> ? A : never;
type ExecuteResult = EffectSuccess<ReturnType<CloudApiShape["executions"]["execute"]>>;

const expectModelVisibleAuthFailure = (execution: ExecuteResult) => {
  expect(execution.status).toBe("completed");
  if (execution.status !== "completed") return;
  expect(execution.isError).toBe(false);
  expect(JSON.stringify(execution.structured)).not.toContain("Internal tool error");
  expect(JSON.stringify(execution.structured)).not.toContain("Internal Tool Error");
  expect(execution.structured).toMatchObject({
    status: "completed",
    result: {
      ok: false,
      error: {
        code: "credential_binding_missing",
        details: {
          category: "authentication",
          recovery: {
            createSecretTool: "executor.coreTools.secrets.create",
            secretsUrl: "https://executor.sh/secrets",
          },
        },
      },
    },
  });
};

describe("cloud auth tool failures", () => {
  it.effect("cloud propagates missing credential binding as model-visible auth failure", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `auth_${crypto.randomUUID().replace(/-/g, "_")}`;
      const scopeId = ScopeId.make(org);

      yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          params: { scopeId },
          payload: {
            ...makeOpenApiHttpApiTestAddSpecPayload(MissingAuthSourceApi, {
              namespace,
              headers: {
                Authorization: { kind: "secret", prefix: "Bearer " },
              },
            }),
            baseUrl: "https://api.example.test",
          },
        }),
      );

      const execution = yield* asOrg(org, (client) =>
        client.executions.execute({
          payload: {
            code: [
              `const result = await tools.${namespace}.default.ping({});`,
              "return result;",
            ].join("\n"),
          },
        }),
      );

      expectModelVisibleAuthFailure(execution);
    }),
  );
});
