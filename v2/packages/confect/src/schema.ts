import {
	defineSchema as defineConvexSchema,
	defineTable as defineConvexTable,
	type GenericTableIndexes,
	type GenericTableSearchIndexes,
	type GenericTableVectorIndexes,
	type IndexTiebreakerField,
	type SchemaDefinition,
	type SearchIndexConfig,
	type TableDefinition,
	type VectorIndexConfig,
	type Expand,
	type SystemFields,
	type SystemIndexes,
	type IdField,
} from "convex/server";
import type { Validator } from "convex/values";
import { Record, Schema } from "effect";

import { Id, schemaToObjectValidator } from "./validators";

/**
 * Recursively removes `readonly` modifiers from all properties and arrays.
 *
 * Effect Schema produces readonly types (e.g. `readonly number[]`, `readonly` properties),
 * but Convex's `GenericDocument` requires mutable `Value[]`. This utility bridges the gap
 * at the type level — the runtime validators produced by `schemaToObjectValidator` are
 * already Convex-native (mutable), so this only affects TypeScript inference.
 */
type DeepMutable<T> =
	T extends ReadonlyArray<infer U>
		? Array<DeepMutable<U>>
		: T extends object
			? { -readonly [K in keyof T]: DeepMutable<T[K]> }
			: T;

const SystemFieldsSchema = Schema.Struct({
	_id: Schema.String,
	_creationTime: Schema.Number,
});

const createSystemFieldsSchema = <TableName extends string>(tableName: TableName) =>
	Schema.Struct({
		_id: Id(tableName),
		_creationTime: Schema.Number,
	});

export interface ConfectTableDefinition<
	TableSchema extends Schema.Schema.AnyNoContext,
	TableValidator extends Validator<unknown, "required" | "optional", string> = Validator<
		DeepMutable<TableSchema["Encoded"]>,
		"required",
		string
	>,
	Indexes extends GenericTableIndexes = {},
	SearchIndexes extends GenericTableSearchIndexes = {},
	VectorIndexes extends GenericTableVectorIndexes = {},
> {
	tableDefinition: TableDefinition<
		TableValidator,
		Indexes,
		SearchIndexes,
		VectorIndexes
	>;
	tableSchema: TableSchema;
	documentSchema: Schema.Schema.AnyNoContext;

	index<
		IndexName extends string,
		FirstFieldPath extends string,
		RestFieldPaths extends string[],
	>(
		name: IndexName,
		fields: [FirstFieldPath, ...RestFieldPaths],
	): ConfectTableDefinition<
		TableSchema,
		TableValidator,
		Expand<
			Indexes &
				Record<
					IndexName,
					[FirstFieldPath, ...RestFieldPaths, IndexTiebreakerField]
				>
		>,
		SearchIndexes,
		VectorIndexes
	>;

	searchIndex<
		IndexName extends string,
		SearchField extends string,
		FilterFields extends string = never,
	>(
		name: IndexName,
		indexConfig: Expand<SearchIndexConfig<SearchField, FilterFields>>,
	): ConfectTableDefinition<
		TableSchema,
		TableValidator,
		Indexes,
		Expand<
			SearchIndexes &
				Record<
					IndexName,
					{
						searchField: SearchField;
						filterFields: FilterFields;
					}
				>
		>,
		VectorIndexes
	>;

	vectorIndex<
		IndexName extends string,
		VectorField extends string,
		FilterFields extends string = never,
	>(
		name: IndexName,
		indexConfig: Expand<VectorIndexConfig<VectorField, FilterFields>>,
	): ConfectTableDefinition<
		TableSchema,
		TableValidator,
		Indexes,
		SearchIndexes,
		Expand<
			VectorIndexes &
				Record<
					IndexName,
					{
						vectorField: VectorField;
						dimensions: number;
						filterFields: FilterFields;
					}
				>
		>
	>;
}

class ConfectTableDefinitionImpl<
	TableSchema extends Schema.Schema.AnyNoContext,
	TableValidator extends Validator<unknown, "required" | "optional", string>,
	Indexes extends GenericTableIndexes = {},
	SearchIndexes extends GenericTableSearchIndexes = {},
	VectorIndexes extends GenericTableVectorIndexes = {},
> implements
		ConfectTableDefinition<
			TableSchema,
			TableValidator,
			Indexes,
			SearchIndexes,
			VectorIndexes
		>
{
	tableSchema: TableSchema;
	documentSchema: Schema.Schema.AnyNoContext;
	tableDefinition: TableDefinition<
		TableValidator,
		Indexes,
		SearchIndexes,
		VectorIndexes
	>;

	constructor(tableSchema: TableSchema) {
		this.tableSchema = tableSchema;
		this.documentSchema = Schema.extend(SystemFieldsSchema, tableSchema) as unknown as Schema.Schema.AnyNoContext;
		const tableValidator = schemaToObjectValidator(tableSchema);
		this.tableDefinition = defineConvexTable(
			tableValidator,
		) as unknown as TableDefinition<TableValidator, Indexes, SearchIndexes, VectorIndexes>;
	}

	index<
		IndexName extends string,
		FirstFieldPath extends string,
		RestFieldPaths extends string[],
	>(
		name: IndexName,
		fields: [FirstFieldPath, ...RestFieldPaths],
	): ConfectTableDefinition<
		TableSchema,
		TableValidator,
		Expand<
			Indexes &
				Record<
					IndexName,
					[FirstFieldPath, ...RestFieldPaths, IndexTiebreakerField]
				>
		>,
		SearchIndexes,
		VectorIndexes
	> {
		this.tableDefinition = this.tableDefinition.index(
			name,
			fields as unknown as [string, ...string[]],
		) as unknown as TableDefinition<TableValidator, Indexes, SearchIndexes, VectorIndexes>;
		return this as unknown as ConfectTableDefinition<
			TableSchema,
			TableValidator,
			Expand<
				Indexes &
					Record<
						IndexName,
						[FirstFieldPath, ...RestFieldPaths, IndexTiebreakerField]
					>
			>,
			SearchIndexes,
			VectorIndexes
		>;
	}

	searchIndex<
		IndexName extends string,
		SearchField extends string,
		FilterFields extends string = never,
	>(
		name: IndexName,
		indexConfig: Expand<SearchIndexConfig<SearchField, FilterFields>>,
	): ConfectTableDefinition<
		TableSchema,
		TableValidator,
		Indexes,
		Expand<
			SearchIndexes &
				Record<
					IndexName,
					{
						searchField: SearchField;
						filterFields: FilterFields;
					}
				>
		>,
		VectorIndexes
	> {
		this.tableDefinition = this.tableDefinition.searchIndex(
			name,
			indexConfig as unknown as SearchIndexConfig<string, string>,
		) as unknown as TableDefinition<TableValidator, Indexes, SearchIndexes, VectorIndexes>;
		return this as unknown as ConfectTableDefinition<
			TableSchema,
			TableValidator,
			Indexes,
			Expand<
				SearchIndexes &
					Record<
						IndexName,
						{
							searchField: SearchField;
							filterFields: FilterFields;
						}
					>
			>,
			VectorIndexes
		>;
	}

	vectorIndex<
		IndexName extends string,
		VectorField extends string,
		FilterFields extends string = never,
	>(
		name: IndexName,
		indexConfig: Expand<VectorIndexConfig<VectorField, FilterFields>>,
	): ConfectTableDefinition<
		TableSchema,
		TableValidator,
		Indexes,
		SearchIndexes,
		Expand<
			VectorIndexes &
				Record<
					IndexName,
					{
						vectorField: VectorField;
						dimensions: number;
						filterFields: FilterFields;
					}
				>
		>
	> {
		this.tableDefinition = this.tableDefinition.vectorIndex(
			name,
			indexConfig as unknown as VectorIndexConfig<string, string>,
		) as unknown as TableDefinition<TableValidator, Indexes, SearchIndexes, VectorIndexes>;
		return this as unknown as ConfectTableDefinition<
			TableSchema,
			TableValidator,
			Indexes,
			SearchIndexes,
			Expand<
				VectorIndexes &
					Record<
						IndexName,
						{
							vectorField: VectorField;
							dimensions: number;
							filterFields: FilterFields;
						}
					>
			>
		>;
	}
}

export const defineTable = <TableSchema extends Schema.Schema.AnyNoContext>(
	tableSchema: TableSchema,
): ConfectTableDefinition<TableSchema> => {
	return new ConfectTableDefinitionImpl(tableSchema);
};

export type GenericConfectSchema = {
	[tableName: string]: ConfectTableDefinition<Schema.Schema.AnyNoContext>;
};

export interface ConfectSchemaDefinition<
	Tables extends GenericConfectSchema,
> {
	tables: Tables;
	convexSchemaDefinition: SchemaDefinition<
		{
			[K in keyof Tables & string]: Tables[K]["tableDefinition"];
		},
		true
	>;
}

export const defineSchema = <Tables extends GenericConfectSchema>(
	tables: Tables,
): ConfectSchemaDefinition<Tables> => {
	for (const [tableName, table] of Object.entries(tables)) {
		table.documentSchema = Schema.extend(
			createSystemFieldsSchema(tableName),
			table.tableSchema,
		);
	}

	const convexTables = Record.map(
		tables,
		(table) => table.tableDefinition,
	) as { [K in keyof Tables & string]: Tables[K]["tableDefinition"] };

	return {
		tables,
		convexSchemaDefinition: defineConvexSchema(convexTables),
	};
};

export type TableNamesInSchema<T extends GenericConfectSchema> = keyof T & string;

export type DocumentFromTable<
	Tables extends GenericConfectSchema,
	TableName extends TableNamesInSchema<Tables>,
> = Expand<
	IdField<TableName> &
		SystemFields &
		DeepMutable<Tables[TableName]["tableSchema"]["Type"]>
>;

export type EncodedDocumentFromTable<
	Tables extends GenericConfectSchema,
	TableName extends TableNamesInSchema<Tables>,
> = Expand<
	IdField<TableName> &
		SystemFields &
		DeepMutable<Tables[TableName]["tableSchema"]["Encoded"]>
>;

export type ConfectDataModel<Tables extends GenericConfectSchema> = {
	[TableName in TableNamesInSchema<Tables>]: {
		document: DocumentFromTable<Tables, TableName>;
		encodedDocument: EncodedDocumentFromTable<Tables, TableName>;
		indexes: Tables[TableName]["tableDefinition"] extends TableDefinition<
			infer _V,
			infer I,
			infer _S,
			infer _Vec
		>
			? Expand<I & SystemIndexes>
			: SystemIndexes;
		searchIndexes: Tables[TableName]["tableDefinition"] extends TableDefinition<
			infer _V,
			infer _I,
			infer S,
			infer _Vec
		>
			? S
			: {};
		vectorIndexes: Tables[TableName]["tableDefinition"] extends TableDefinition<
			infer _V,
			infer _I,
			infer _S,
			infer Vec
		>
			? Vec
			: {};
	};
};

export type TablesFromSchemaDefinition<
	S extends ConfectSchemaDefinition<GenericConfectSchema>,
> = S extends ConfectSchemaDefinition<infer T> ? T : never;
