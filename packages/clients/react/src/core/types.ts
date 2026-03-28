export type SourceRemoveResult = {
  removed: boolean;
};

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; data: T };

export type MutationState<T> = {
  status: "idle" | "pending" | "success" | "error";
  data: T | null;
  error: Error | null;
};

export type ReactivityKeys = Readonly<Record<string, ReadonlyArray<unknown>>>;
