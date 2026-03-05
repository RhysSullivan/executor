import {
  ActorUnauthenticatedError,
  type ActorShape,
} from "@executor-v2/domain";
import { type WorkspaceId } from "@executor-v2/schema";
import * as PlatformHeaders from "@effect/platform/Headers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

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
  "@executor-v2/management-api/ControlPlaneActorResolver",
)<ControlPlaneActorResolver, ControlPlaneActorResolverShape>() {}
