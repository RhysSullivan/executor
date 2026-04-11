import type { Effect } from "effect";

import type { StorageError } from "./errors";

export type WhereOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "not_in"
  | "contains"
  | "starts_with"
  | "ends_with";

export type WhereValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | Date
  | null;

export interface Where {
  readonly field: string;
  readonly operator?: WhereOperator;
  readonly value: WhereValue;
  readonly connector?: "AND" | "OR";
  readonly mode?: "sensitive" | "insensitive";
}

export interface SortBy {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export type Select = readonly string[];

export interface StorageCapabilities {
  readonly supportsJSON: boolean;
  readonly supportsDates: boolean;
  readonly supportsBooleans: boolean;
  readonly supportsArrays: boolean;
  readonly supportsBytes: boolean;
  readonly supportsTransactions: boolean;
  readonly supportsReturning: boolean;
}

export interface CreateArgs {
  readonly model: string;
  readonly data: Record<string, unknown>;
}

export interface FindOneArgs {
  readonly model: string;
  readonly where: readonly Where[];
  readonly select?: Select;
}

export interface FindManyArgs {
  readonly model: string;
  readonly where?: readonly Where[];
  readonly limit?: number;
  readonly offset?: number;
  readonly sortBy?: SortBy;
  readonly select?: Select;
}

export interface UpdateArgs {
  readonly model: string;
  readonly where: readonly Where[];
  readonly update: Record<string, unknown>;
}

export interface UpdateManyArgs {
  readonly model: string;
  readonly where: readonly Where[];
  readonly update: Record<string, unknown>;
}

export interface DeleteArgs {
  readonly model: string;
  readonly where: readonly Where[];
}

export interface DeleteManyArgs {
  readonly model: string;
  readonly where: readonly Where[];
}

export interface CountArgs {
  readonly model: string;
  readonly where?: readonly Where[];
}

export interface ExecutorStorage {
  readonly id: string;
  readonly capabilities: StorageCapabilities;

  readonly create: <T = unknown>(args: CreateArgs) => Effect.Effect<T, StorageError>;
  readonly findOne: <T = unknown>(args: FindOneArgs) => Effect.Effect<T | null, StorageError>;
  readonly findMany: <T = unknown>(args: FindManyArgs) => Effect.Effect<readonly T[], StorageError>;
  readonly update: <T = unknown>(args: UpdateArgs) => Effect.Effect<T | null, StorageError>;
  readonly updateMany: (args: UpdateManyArgs) => Effect.Effect<number, StorageError>;
  readonly delete: (args: DeleteArgs) => Effect.Effect<boolean, StorageError>;
  readonly deleteMany: (args: DeleteManyArgs) => Effect.Effect<number, StorageError>;
  readonly count: (args: CountArgs) => Effect.Effect<number, StorageError>;
  readonly transaction: <A, E, R>(
    callback: (tx: ExecutorStorageTransaction) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StorageError, R>;
}

export type ExecutorStorageTransaction = Omit<ExecutorStorage, "transaction">;
