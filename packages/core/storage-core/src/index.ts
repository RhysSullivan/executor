export {
  type DBFieldType,
  type DBPrimitive,
  type DBFieldAttribute,
  type DBFieldAttributeConfig,
  type DBSchema,
  type InferDBValueType,
  type InferDBFieldInput,
  type InferDBFieldOutput,
  type InferDBFieldsInput,
  type InferDBFieldsOutput,
} from "./schema";

export { typedAdapter, type TypedAdapter } from "./typed";

export { createAdapter, type CreateAdapterOptions } from "./factory";

export { StorageError, UniqueViolationError } from "./errors";

export {
  whereOperators,
  type WhereOperator,
  type Where,
  type CleanedWhere,
  type JoinOption,
  type JoinConfig,
  type DBAdapter,
  type DBTransactionAdapter,
  type CustomAdapter,
  type DBAdapterDebugLogOption,
  type DBAdapterFactoryConfig,
  type DBAdapterSchemaCreation,
  type StorageFailure,
} from "./adapter";
