import { Data, Effect, Schema } from "effect";

import type { ElicitationContext, ElicitationResponse } from "./elicitation";
import { ScopeId } from "./ids";
import type { AnyPlugin, PluginExtensions } from "./plugin";

export const ExecutionId = Schema.String.pipe(Schema.brand("ExecutionId"));
export type ExecutionId = typeof ExecutionId.Type;

export const ExecutionToolCallId = Schema.String.pipe(Schema.brand("ExecutionToolCallId"));
export type ExecutionToolCallId = typeof ExecutionToolCallId.Type;

export const ExecutionInteractionId = Schema.String.pipe(Schema.brand("ExecutionInteractionId"));
export type ExecutionInteractionId = typeof ExecutionInteractionId.Type;

export type ExecutionTrigger = {
  readonly kind: string;
  readonly metadata?: Record<string, unknown>;
};

export type ToolCallStatus = "completed" | "failed";
export type InteractionStatus = "accepted" | "declined" | "cancelled" | "failed";
export type ExecutionStatus = "completed" | "failed";

export class ExecutionStarted extends Data.TaggedClass("ExecutionStarted")<{
  readonly executionId: ExecutionId;
  readonly scopeId: ScopeId;
  readonly code: string;
  readonly trigger?: ExecutionTrigger;
  readonly startedAt: Date;
}> {}

export class ToolCallStarted extends Data.TaggedClass("ToolCallStarted")<{
  readonly executionId: ExecutionId;
  readonly toolCallId: ExecutionToolCallId;
  readonly scopeId: ScopeId;
  readonly path: string;
  readonly args: unknown;
  readonly startedAt: Date;
}> {}

export class ToolCallFinished extends Data.TaggedClass("ToolCallFinished")<{
  readonly executionId: ExecutionId;
  readonly toolCallId: ExecutionToolCallId;
  readonly scopeId: ScopeId;
  readonly path: string;
  readonly status: ToolCallStatus;
  readonly result?: unknown;
  readonly error?: string;
  readonly completedAt: Date;
}> {}

export class InteractionStarted extends Data.TaggedClass("InteractionStarted")<{
  readonly executionId: ExecutionId;
  readonly interactionId: ExecutionInteractionId;
  readonly scopeId: ScopeId;
  readonly context: ElicitationContext;
  readonly startedAt: Date;
}> {}

export class InteractionResolved extends Data.TaggedClass("InteractionResolved")<{
  readonly executionId: ExecutionId;
  readonly interactionId: ExecutionInteractionId;
  readonly scopeId: ScopeId;
  readonly status: InteractionStatus;
  readonly response?: ElicitationResponse;
  readonly error?: string;
  readonly completedAt: Date;
}> {}

export class ExecutionFinished extends Data.TaggedClass("ExecutionFinished")<{
  readonly executionId: ExecutionId;
  readonly scopeId: ScopeId;
  readonly status: ExecutionStatus;
  readonly result?: unknown;
  readonly error?: string;
  readonly logs?: readonly string[];
  readonly completedAt: Date;
}> {}

export type ExecutionEvent =
  | ExecutionStarted
  | ToolCallStarted
  | ToolCallFinished
  | InteractionStarted
  | InteractionResolved
  | ExecutionFinished;

export interface ExecutionObserver<E = never> {
  readonly handle: (event: ExecutionEvent) => Effect.Effect<void, E>;
}

export const noopExecutionObserver: ExecutionObserver = {
  handle: () => Effect.void,
};

export const ignoreExecutionObserverErrors = (
  observer: ExecutionObserver<unknown>,
): ExecutionObserver => ({
  handle: (event) => observer.handle(event).pipe(Effect.catchCause(() => Effect.void)),
});

export const composeExecutionObservers = <TPlugins extends readonly AnyPlugin[]>(
  plugins: TPlugins,
  extensions: PluginExtensions<TPlugins>,
): ExecutionObserver => {
  const observers: ExecutionObserver<unknown>[] = [];

  for (const plugin of plugins) {
    const observer = plugin.runtime?.executionObserver?.(
      extensions[plugin.id as keyof PluginExtensions<TPlugins>] as never,
    );
    if (observer) {
      observers.push(observer);
    }
  }

  if (observers.length === 0) {
    return noopExecutionObserver;
  }

  return {
    handle: (event) =>
      Effect.forEach(
        observers,
        (observer) => observer.handle(event).pipe(Effect.catchCause(() => Effect.void)),
        { discard: true },
      ),
  };
};
