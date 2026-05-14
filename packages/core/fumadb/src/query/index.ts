import type {
  AnySchema,
  AnyTable,
  IdColumn,
  Relation,
} from "../schema/create";
import type { Condition, ConditionBuilder } from "./condition-builder";
import type { ORMAdapter } from "./orm";

export type { Condition, ConditionBuilder } from "./condition-builder";

export type AnySelectClause = SelectClause<AnyTable>;

export type SelectClause<T extends AnyTable> = true | (keyof T["columns"])[];

type TableToColumnValues<T extends AnyTable> = {
  [K in keyof T["columns"]]: T["columns"][K]["$out"];
};

type PickNullable<T> = {
  [P in keyof T as null extends T[P] ? P : never]: T[P];
};

type PickNotNullable<T> = {
  [P in keyof T as null extends T[P] ? never : P]: T[P];
};

type TableToInsertValues<T extends AnyTable> = Partial<
  PickNullable<{
    [K in keyof T["columns"]]: T["columns"][K]["$in"];
  }>
> &
  PickNotNullable<{
    [K in keyof T["columns"]]: T["columns"][K]["$in"];
  }>;

type TableToUpdateValues<T extends AnyTable> = {
  [K in keyof T["columns"]]?: T["columns"][K] extends IdColumn
    ? never
    : T["columns"][K]["$in"];
};

type MainSelectResult<
  S extends SelectClause<T>,
  T extends AnyTable,
> = S extends true
  ? TableToColumnValues<T>
  : S extends (keyof T["columns"])[]
    ? Pick<TableToColumnValues<T>, S[number]>
    : never;

export type JoinBuilder<T extends AnyTable, Out = {}> = {
  [K in keyof T["relations"]]: T["relations"][K] extends Relation<
    infer Type,
    infer Target
  >
    ? <Select extends SelectClause<Target> = true, JoinOut = {}>(
        options?: Type extends "many"
          ? FindManyOptions<Target, Select, JoinOut, false>
          : FindFirstOptions<Target, Select, JoinOut, false>
      ) => JoinBuilder<
        T,
        Out & {
          [$K in K]: MapRelationType<
            SelectResult<Target, JoinOut, Select>,
            T["relations"][K]["implied"]
          >[Type];
        }
      >
    : never;
};

type SelectResult<
  T extends AnyTable,
  JoinOut,
  Select extends SelectClause<T>,
> = MainSelectResult<Select, T> & JoinOut;

export type OrderBy<Column = string> = [columnName: Column, "asc" | "desc"];

export type FindFirstOptions<
  T extends AnyTable = AnyTable,
  Select extends SelectClause<T> = SelectClause<T>,
  JoinOut = {},
  IsRoot extends boolean = true,
> = Omit<
  FindManyOptions<T, Select, JoinOut, IsRoot>,
  IsRoot extends true ? "limit" : "limit" | "offset" | "orderBy"
>;

interface MapRelationType<Type, Implied extends boolean> {
  one: Implied extends true ? Type | null : Type;
  many: Type[];
}

export type FindManyOptions<
  T extends AnyTable = AnyTable,
  Select extends SelectClause<T> = SelectClause<T>,
  JoinOut = {},
  IsRoot extends boolean = true,
> = {
  select?: Select;
  where?: (eb: ConditionBuilder<T["columns"]>) => Condition | boolean;

  limit?: number;
  orderBy?: OrderBy<keyof T["columns"]> | OrderBy<keyof T["columns"]>[];
  join?: (builder: JoinBuilder<T, {}>) => JoinBuilder<T, JoinOut>;
} & (IsRoot extends true
  ? {
      // drizzle doesn't support `offset` in join queries (this may be changed in future, we can add it back)
      offset?: number;
    }
  : {});

export interface AbstractQuery<S extends AnySchema> {
  internal: ORMAdapter;

  /**
   * The code in the transaction will receive a transaction query instance.
   *
   * If you use that instance to write the database (e.g. insert) and an error is thrown, FumaDB will automatically rollback the changes + rethrow the error.
   *
   * It works by using the transaction API that's natively available for the database/ORM, or falling back to the soft transaction layer built by FumaDB.
   */
  transaction: <T>(run: (orm: AbstractQuery<S>) => Promise<T>) => Promise<T>;

  /**
   * Count (all)
   */
  count: <TableName extends keyof S["tables"]>(
    table: TableName,
    v?: {
      where?: (
        eb: ConditionBuilder<S["tables"][TableName]["columns"]>
      ) => Condition | boolean;
    }
  ) => Promise<number>;

  findFirst: <
      TableName extends keyof S["tables"],
      JoinOut = {},
      Select extends SelectClause<S["tables"][TableName]> = true,
    >(
      table: TableName,
      v: FindFirstOptions<S["tables"][TableName], Select, JoinOut>) => Promise<SelectResult<S["tables"][TableName], JoinOut, Select> | null>;

  findMany: <
      TableName extends keyof S["tables"],
      JoinOut = {},
      Select extends SelectClause<S["tables"][TableName]> = true,
    >(
      table: TableName,
      v?: FindManyOptions<S["tables"][TableName], Select, JoinOut>) => Promise<SelectResult<S["tables"][TableName], JoinOut, Select>[]>;

  // not every database supports returning in update/delete, hence they will not be implemented.
  // TODO: maybe reconsider this in future

  /**
   * Upsert a **single row**.
   *
   * For ORMs:
   * - use built-in method whenever possible.
   *
   * Otherwise:
   * - run `update`.
   * - if updated zero rows, run `create`.
   */
  upsert: <TableName extends keyof S["tables"]>(
    table: TableName,
    v: {
      where: (
        eb: ConditionBuilder<S["tables"][TableName]["columns"]>
      ) => Condition | boolean;
      update: TableToUpdateValues<S["tables"][TableName]>;
      create: TableToInsertValues<S["tables"][TableName]>;
    }
  ) => Promise<void>;

  /**
   * Note: you cannot update the id of a row, some databases don't support that (including MongoDB).
   */
  updateMany: <TableName extends keyof S["tables"]>(
      table: TableName,
      v: {
        where?: (
          eb: ConditionBuilder<S["tables"][TableName]["columns"]>
        ) => Condition | boolean;
        set: TableToUpdateValues<S["tables"][TableName]>;
      }) => Promise<void>;

  createMany: <TableName extends keyof S["tables"]>(
      table: TableName,
      values: TableToInsertValues<S["tables"][TableName]>[]) => Promise<
      {
        _id: string;
      }[]
    >;

  /**
   * Note: when you don't need to receive the result, always use `createMany` for better performance.
   */
  create: <TableName extends keyof S["tables"]>(
      table: TableName,
      values: TableToInsertValues<S["tables"][TableName]>) => Promise<TableToColumnValues<S["tables"][TableName]>>;

  deleteMany: <TableName extends keyof S["tables"]>(
      table: TableName,
      v: {
        where?: (
          eb: ConditionBuilder<S["tables"][TableName]["columns"]>
        ) => Condition | boolean;
      }) => Promise<void>;
}
