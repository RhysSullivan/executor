// Vendored from better-auth (@better-auth/core/db/type) under MIT.
// See LICENSE.md. Stripped of auth-specific model names.

import type { StandardSchemaV1 } from "@standard-schema/spec";

export type DBFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | `${"string" | "number"}[]`
  | Array<string>;

export type DBPrimitive =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | string[]
  | number[]
  | (Record<string, unknown> | unknown[]);

export type InferDBValueType<T extends DBFieldType> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "date"
        ? Date
        : T extends "json"
          ? Record<string, unknown>
          : T extends `${infer U}[]`
            ? U extends "string"
              ? string[]
              : number[]
            : T extends Array<unknown>
              ? T[number]
              : never;

export type InferDBFieldOutput<T extends DBFieldAttribute> =
  T["returned"] extends false
    ? never
    : T["required"] extends false
      ? InferDBValueType<T["type"]> | undefined | null
      : InferDBValueType<T["type"]>;

export type InferDBFieldInput<T extends DBFieldAttribute> = InferDBValueType<
  T["type"]
>;

export type InferDBFieldsInput<Field> =
  Field extends Record<infer Key, DBFieldAttribute>
    ? {
        [K in Key as Field[K]["required"] extends false
          ? never
          : Field[K]["defaultValue"] extends string | number | boolean | Date
            ? never
            : Field[K]["input"] extends false
              ? never
              : K]: InferDBFieldInput<Field[K]>;
      } & {
        [K in Key as Field[K]["input"] extends false ? never : K]?:
          | InferDBFieldInput<Field[K]>
          | undefined
          | null;
      }
    : {};

export type InferDBFieldsOutput<
  Fields extends Record<string, DBFieldAttribute>,
> =
  Fields extends Record<infer Key, DBFieldAttribute>
    ? {
        [K in Key as Fields[K]["returned"] extends false
          ? never
          : Fields[K]["required"] extends false
            ? Fields[K]["defaultValue"] extends
                | boolean
                | string
                | number
                | Date
              ? K
              : never
            : K]: InferDBFieldOutput<Fields[K]>;
      } & {
        [K in Key as Fields[K]["returned"] extends false
          ? never
          : Fields[K]["required"] extends false
            ? Fields[K]["defaultValue"] extends
                | boolean
                | string
                | number
                | Date
              ? never
              : K
            : never]?: InferDBFieldOutput<Fields[K]> | null;
      }
    : never;

export type DBFieldAttributeConfig = {
  /** Required on new records. @default true */
  required?: boolean | undefined;
  /** Returned from `find` / `create` responses. @default true */
  returned?: boolean | undefined;
  /** Accepted in create input. @default true */
  input?: boolean | undefined;
  /**
   * Default value for the field. Not a DB-level default — applied when
   * creating a new record.
   */
  defaultValue?: (DBPrimitive | (() => DBPrimitive)) | undefined;
  /**
   * Update value for the field. Creates an onUpdate trigger on supported
   * adapters and is applied on every update.
   */
  onUpdate?: (() => DBPrimitive) | undefined;
  /** Transform value before storing / after reading. */
  transform?:
    | {
        input?: (value: DBPrimitive) => DBPrimitive | Promise<DBPrimitive>;
        output?: (value: DBPrimitive) => DBPrimitive | Promise<DBPrimitive>;
      }
    | undefined;
  /** Foreign-key reference to another model. */
  references?:
    | {
        model: string;
        field: string;
        /** @default "cascade" */
        onDelete?:
          | "no action"
          | "restrict"
          | "cascade"
          | "set null"
          | "set default";
      }
    | undefined;
  unique?: boolean | undefined;
  /** Store as bigint instead of integer. */
  bigint?: boolean | undefined;
  /** Runtime validator (Standard Schema). */
  validator?:
    | {
        input?: StandardSchemaV1;
        output?: StandardSchemaV1;
      }
    | undefined;
  /** Override the physical column name in the database. */
  fieldName?: string | undefined;
  /** Hint that a string column should be varchar instead of text. */
  sortable?: boolean | undefined;
  /** Create an index on this column. @default false */
  index?: boolean | undefined;
};

export type DBFieldAttribute<T extends DBFieldType = DBFieldType> = {
  type: T;
} & DBFieldAttributeConfig;

export type DBSchema = Record<
  string,
  {
    /** Column definitions. */
    fields: Record<string, DBFieldAttribute>;
    /** Skip this table when generating migrations. @default false */
    disableMigration?: boolean | undefined;
    /** Physical table name override. Defaults to the object key. */
    modelName?: string | undefined;
  }
>;
