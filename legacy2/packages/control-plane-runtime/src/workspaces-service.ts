import { type SqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import {
  makeControlPlaneWorkspacesService,
  type ControlPlaneWorkspacesServiceShape,
} from "@executor-v2/management-api";
import { type Workspace } from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { createSqlSourceStoreErrorMapper } from "./control-plane-row-helpers";

type WorkspaceRows = Pick<SqlControlPlanePersistence["rows"], "workspaces">;

const sourceStoreError = createSqlSourceStoreErrorMapper("workspaces");

const sortWorkspaces = (workspaces: ReadonlyArray<Workspace>): Array<Workspace> =>
  [...workspaces].sort((left, right) => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName === rightName) {
      return left.id.localeCompare(right.id);
    }

    return leftName.localeCompare(rightName);
  });

export const createRuntimeHostWorkspacesService = (
  rows: WorkspaceRows,
): ControlPlaneWorkspacesServiceShape =>
  makeControlPlaneWorkspacesService({
    listWorkspaces: () =>
      Effect.gen(function* () {
        const workspaces = yield* rows.workspaces.list().pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("workspaces.list", error),
          ),
        );

        return sortWorkspaces(workspaces);
      }),

    upsertWorkspace: (input) =>
      Effect.gen(function* () {
        const existingOption = input.payload.id
          ? yield* rows.workspaces.getById(input.payload.id).pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("workspaces.get_by_id", error),
            ),
          )
          : Option.none<Workspace>();

        const now = Date.now();
        const existing = Option.getOrNull(existingOption);

        const nextWorkspace: Workspace = {
          id: existing?.id ?? (input.payload.id ?? (`ws_${crypto.randomUUID()}` as Workspace["id"])),
          organizationId: input.payload.organizationId,
          name: input.payload.name,
          createdByAccountId: existing?.createdByAccountId ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        yield* rows.workspaces.upsert(nextWorkspace).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("workspaces.upsert_write", error),
          ),
        );

        return nextWorkspace;
      }),
  });
