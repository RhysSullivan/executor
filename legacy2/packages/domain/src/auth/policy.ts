import type {
  Permission,
  WorkspaceId,
  OrganizationId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import { Actor, ActorForbiddenError, type ActorShape } from "./actor";

export type Policy<E = never, R = never> = Effect.Effect<
  void,
  ActorForbiddenError | E,
  Actor | R
>;

export const policy = <E, R>(
  predicate: (actor: ActorShape) => Effect.Effect<boolean, E, R>,
  onForbidden: (actor: ActorShape) => ActorForbiddenError,
): Policy<E, R> =>
  Effect.gen(function* () {
    const actor = yield* Actor;
    const allowed = yield* predicate(actor);

    if (!allowed) {
      return yield* onForbidden(actor);
    }
  });

export const requirePermission = (request: {
  permission: Permission;
  workspaceId?: WorkspaceId;
  organizationId?: OrganizationId;
}): Policy =>
  Effect.flatMap(Actor, (actor) => actor.requirePermission(request));

export const requireWorkspaceAccess = (workspaceId: WorkspaceId): Policy =>
  Effect.flatMap(Actor, (actor) => actor.requireWorkspaceAccess(workspaceId));

export const withPolicy =
  <E1, R1>(auth: Policy<E1, R1>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | E1 | ActorForbiddenError, R | R1 | Actor> =>
    Effect.zipRight(auth, self);

export const all = <E, R>(
  policies: ReadonlyArray<Policy<E, R>>,
): Policy<E, R> =>
  Effect.forEach(policies, (item) => item, { discard: true });

export const any = <E, R>(
  policies: readonly [Policy<E, R>, ...Array<Policy<E, R>>],
): Policy<E, R> => Effect.firstSuccessOf(policies);
