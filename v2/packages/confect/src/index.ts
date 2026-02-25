export {
	defineSchema,
	defineTable,
	type ConfectSchemaDefinition,
	type ConfectTableDefinition,
	type GenericConfectSchema,
	type TableNamesInSchema,
	type DocumentFromTable,
	type EncodedDocumentFromTable,
	type ConfectDataModel,
	type TablesFromSchemaDefinition,
} from "./schema";

export {
	schemaToValidator,
	schemaToObjectValidator,
	Id,
	UnsupportedSchemaError,
	TopLevelMustBeObjectError,
	IndexSignaturesNotSupportedError,
} from "./validators";

export {
	NotUniqueError,
	ConfectQueryCtx,
	ConfectMutationCtx,
	ConfectActionCtx,
	makeQueryCtx,
	makeMutationCtx,
	makeActionCtx,
	type ConfectDatabaseReader,
	type ConfectDatabaseWriter,
	type ConfectAuth,
	type LooseIndexRangeBuilder,
} from "./ctx";

export { ConvexClient, ConvexClientLayer, ConvexHttpClientLayer, type ConvexClientService } from "./client";

export {
	Cursor,
	PaginationOptionsSchema,
	PaginationResultSchema,
} from "./pagination";
