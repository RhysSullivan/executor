import { type WorkspaceId } from "#schema";
import * as PlatformHeaders from "@effect/platform/Headers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import {
  type ActorShape,
  type ActorUnauthenticatedError,
} from "#domain";

export type ResolveActorInput = {
  headers: PlatformHeaders.Headers;
};

export type ResolveWorkspaceActorInput = {
  workspaceId: WorkspaceId;
  headers: PlatformHeaders.Headers;
};

export type ControlPlaneActorResolverShape = {
  resolveActor: (
    input: ResolveActorInput,
  ) => Effect.Effect<ActorShape, ActorUnauthenticatedError>;
  resolveWorkspaceActor: (
    input: ResolveWorkspaceActorInput,
  ) => Effect.Effect<ActorShape, ActorUnauthenticatedError>;
};

export class ControlPlaneActorResolver extends Context.Tag(
  "#api/ControlPlaneActorResolver",
)<ControlPlaneActorResolver, ControlPlaneActorResolverShape>() {}
