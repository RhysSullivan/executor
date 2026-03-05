import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ControlPlaneAuthHeaders,
  makeSqlControlPlaneRuntime,
  type SqlControlPlaneRuntime,
} from "./index";

const makeRuntime = Effect.acquireRelease(
  makeSqlControlPlaneRuntime({ localDataDir: ":memory:" }),
  (runtime) =>
    Effect.tryPromise({
      try: async () => {
        await runtime.close();
        await runtime.webHandler.dispose();
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.orDie),
);

const callApi = (input: {
  runtime: SqlControlPlaneRuntime;
  method: string;
  path: string;
  accountId?: string;
  body?: unknown;
}) =>
  Effect.tryPromise({
    try: async () => {
      const headers = new Headers();
      if (input.accountId) {
        headers.set(ControlPlaneAuthHeaders.accountId, input.accountId);
      }
      if (input.body !== undefined) {
        headers.set("content-type", "application/json");
      }

      const response = await input.runtime.webHandler.handler(
        new Request(`http://control-plane.local${input.path}`, {
          method: input.method,
          headers,
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
        }),
      );

      const contentType = response.headers.get("content-type") ?? "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : await response.text();

      return {
        status: response.status,
        payload,
      };
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

describe("control-plane-runtime", () => {
  it.scoped("supports full CRUD flow over HTTP API", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime;

      const createOrg = yield* callApi({
        runtime,
        method: "POST",
        path: "/v1/organizations",
        accountId: "acc_1",
        body: {
          name: "Acme",
        },
      });
      expect(createOrg.status).toBe(200);
      const organizationId = (createOrg.payload as Record<string, unknown>).id as string;

      const createWorkspace = yield* callApi({
        runtime,
        method: "POST",
        path: `/v1/organizations/${organizationId}/workspaces`,
        accountId: "acc_1",
        body: {
          name: "Primary",
        },
      });
      expect(createWorkspace.status).toBe(200);
      expect((createWorkspace.payload as Record<string, unknown>).createdByAccountId).toBe("acc_1");
      const workspaceId = (createWorkspace.payload as Record<string, unknown>).id as string;

      const createSource = yield* callApi({
        runtime,
        method: "POST",
        path: `/v1/workspaces/${workspaceId}/sources`,
        accountId: "acc_1",
        body: {
          name: "Github",
          kind: "openapi",
          endpoint: "https://api.github.com/openapi.json",
          configJson: "{}",
        },
      });
      expect(createSource.status).toBe(200);

      const createPolicy = yield* callApi({
        runtime,
        method: "POST",
        path: `/v1/workspaces/${workspaceId}/policies`,
        accountId: "acc_1",
        body: {
          resourceType: "tool_path",
          resourcePattern: "source.github.*",
          matchType: "glob",
          effect: "allow",
          approvalMode: "auto",
          priority: 50,
          enabled: true,
        },
      });
      expect(createPolicy.status).toBe(200);

      const listSources = yield* callApi({
        runtime,
        method: "GET",
        path: `/v1/workspaces/${workspaceId}/sources`,
        accountId: "acc_1",
      });
      expect(listSources.status).toBe(200);
      expect(Array.isArray(listSources.payload)).toBe(true);
      expect((listSources.payload as Array<unknown>).length).toBe(1);

      const listPolicies = yield* callApi({
        runtime,
        method: "GET",
        path: `/v1/workspaces/${workspaceId}/policies`,
        accountId: "acc_1",
      });
      expect(listPolicies.status).toBe(200);
      expect(Array.isArray(listPolicies.payload)).toBe(true);
      expect((listPolicies.payload as Array<unknown>).length).toBe(1);
    }),
  );

  it.scoped("scopes organization list/get to memberships", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime;

      const orgOne = yield* callApi({
        runtime,
        method: "POST",
        path: "/v1/organizations",
        accountId: "acc_1",
        body: { name: "Org One" },
      });
      const orgOneId = (orgOne.payload as Record<string, unknown>).id as string;

      const orgTwo = yield* callApi({
        runtime,
        method: "POST",
        path: "/v1/organizations",
        accountId: "acc_2",
        body: { name: "Org Two" },
      });
      const orgTwoId = (orgTwo.payload as Record<string, unknown>).id as string;

      const listForAcc1 = yield* callApi({
        runtime,
        method: "GET",
        path: "/v1/organizations",
        accountId: "acc_1",
      });

      expect(listForAcc1.status).toBe(200);
      expect(Array.isArray(listForAcc1.payload)).toBe(true);
      expect((listForAcc1.payload as Array<unknown>).length).toBe(1);

      const getOtherOrg = yield* callApi({
        runtime,
        method: "GET",
        path: `/v1/organizations/${orgTwoId}`,
        accountId: "acc_1",
      });

      expect(orgOneId.length > 0).toBe(true);
      expect(getOtherOrg.status).toBe(404);
    }),
  );

  it.scoped("prevents viewers from workspace manage actions", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime;

      const createOrg = yield* callApi({
        runtime,
        method: "POST",
        path: "/v1/organizations",
        accountId: "owner_acc",
        body: { name: "Secured Org" },
      });
      const organizationId = (createOrg.payload as Record<string, unknown>).id as string;

      const createWorkspace = yield* callApi({
        runtime,
        method: "POST",
        path: `/v1/organizations/${organizationId}/workspaces`,
        accountId: "owner_acc",
        body: { name: "Secured WS" },
      });
      const workspaceId = (createWorkspace.payload as Record<string, unknown>).id as string;

      const createViewerMembership = yield* callApi({
        runtime,
        method: "POST",
        path: `/v1/organizations/${organizationId}/memberships`,
        accountId: "owner_acc",
        body: {
          accountId: "viewer_acc",
          role: "viewer",
          status: "active",
        },
      });
      expect(createViewerMembership.status).toBe(200);

      const viewerDelete = yield* callApi({
        runtime,
        method: "DELETE",
        path: `/v1/workspaces/${workspaceId}`,
        accountId: "viewer_acc",
      });

      expect(viewerDelete.status).toBe(403);
    }),
  );

  it.scoped("blocks organization manage across tenants", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime;

      const createOrgA = yield* callApi({
        runtime,
        method: "POST",
        path: "/v1/organizations",
        accountId: "acc_a",
        body: { name: "Org A" },
      });
      const orgAId = (createOrgA.payload as Record<string, unknown>).id as string;

      const createOrgB = yield* callApi({
        runtime,
        method: "POST",
        path: "/v1/organizations",
        accountId: "acc_b",
        body: { name: "Org B" },
      });
      const orgBId = (createOrgB.payload as Record<string, unknown>).id as string;

      const patchOtherOrg = yield* callApi({
        runtime,
        method: "PATCH",
        path: `/v1/organizations/${orgBId}`,
        accountId: "acc_a",
        body: { name: "Renamed" },
      });
      expect(orgAId.length > 0).toBe(true);
      expect(patchOtherOrg.status).toBe(403);

      const deleteOtherOrg = yield* callApi({
        runtime,
        method: "DELETE",
        path: `/v1/organizations/${orgBId}`,
        accountId: "acc_a",
      });
      expect(deleteOtherOrg.status).toBe(403);
    }),
  );

  it.scoped("suspended creators cannot manage previously created workspaces", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime;

      const createOrg = yield* callApi({
        runtime,
        method: "POST",
        path: "/v1/organizations",
        accountId: "creator_acc",
        body: { name: "Creator Org" },
      });
      const organizationId = (createOrg.payload as Record<string, unknown>).id as string;

      const createWorkspace = yield* callApi({
        runtime,
        method: "POST",
        path: `/v1/organizations/${organizationId}/workspaces`,
        accountId: "creator_acc",
        body: { name: "Creator WS" },
      });
      const workspaceId = (createWorkspace.payload as Record<string, unknown>).id as string;

      const suspendCreator = yield* callApi({
        runtime,
        method: "PATCH",
        path: `/v1/organizations/${organizationId}/memberships/creator_acc`,
        accountId: "creator_acc",
        body: { status: "suspended" },
      });
      expect(suspendCreator.status).toBe(200);

      const deleteWorkspace = yield* callApi({
        runtime,
        method: "DELETE",
        path: `/v1/workspaces/${workspaceId}`,
        accountId: "creator_acc",
      });

      expect(deleteWorkspace.status).toBe(403);
    }),
  );

  it.scoped("deleting organization cascades and blocks stale org operations", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime;

      const createOrg = yield* callApi({
        runtime,
        method: "POST",
        path: "/v1/organizations",
        accountId: "acc_del",
        body: { name: "Delete Me" },
      });
      const organizationId = (createOrg.payload as Record<string, unknown>).id as string;

      const createWorkspace = yield* callApi({
        runtime,
        method: "POST",
        path: `/v1/organizations/${organizationId}/workspaces`,
        accountId: "acc_del",
        body: { name: "Delete WS" },
      });
      const workspaceId = (createWorkspace.payload as Record<string, unknown>).id as string;

      const deleteOrg = yield* callApi({
        runtime,
        method: "DELETE",
        path: `/v1/organizations/${organizationId}`,
        accountId: "acc_del",
      });
      expect(deleteOrg.status).toBe(200);

      const deletedWorkspaceLookup = yield* Effect.either(
        runtime.service.getWorkspace(workspaceId as never),
      );
      expect(deletedWorkspaceLookup._tag).toBe("Left");

      const listStaleWorkspaces = yield* callApi({
        runtime,
        method: "GET",
        path: `/v1/organizations/${organizationId}/workspaces`,
        accountId: "acc_del",
      });
      expect(listStaleWorkspaces.status).toBe(403);

      const createStaleWorkspace = yield* callApi({
        runtime,
        method: "POST",
        path: `/v1/organizations/${organizationId}/workspaces`,
        accountId: "acc_del",
        body: { name: "Should Fail" },
      });
      expect(createStaleWorkspace.status).toBe(403);

      const getDeletedWorkspace = yield* callApi({
        runtime,
        method: "GET",
        path: `/v1/workspaces/${workspaceId}`,
        accountId: "acc_del",
      });
      expect(getDeletedWorkspace.status).toBe(403);
    }),
  );

  it.scoped("rejects unauthenticated calls", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime;

      const response = yield* callApi({
        runtime,
        method: "GET",
        path: "/v1/organizations",
      });

      expect(response.status).toBe(401);
    }),
  );
});
