import type {
	FunctionReference,
	FunctionReturnType,
	GenericDatabaseReader,
	GenericDatabaseWriter,
	GenericMutationCtx,
	GenericQueryCtx,
	GenericActionCtx,
	OptionalRestArgs,
	PaginationOptions,
	PaginationResult,
	Expression,
	FilterBuilder,
	IndexRange,
	SearchFilter,
	GenericDataModel,
	GenericDocument,
	GenericTableInfo,
	WithoutSystemFields,
	Scheduler,
} from "convex/server";
import type { GenericId, Value } from "convex/values";
import * as Chunk from "effect/Chunk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
	GenericConfectSchema,
	TableNamesInSchema,
	DocumentFromTable,
	EncodedDocumentFromTable,
} from "./schema";

export type {
	GenericConfectSchema,
	TableNamesInSchema,
	DocumentFromTable,
	EncodedDocumentFromTable,
};

/**
 * A loosely-typed index range builder that allows chaining `.eq`, `.gt`, `.gte`, `.lt`, `.lte`
 * with string field names and `Value` values. This is the type exposed to Confect consumers since
 * Confect erases table-specific index type information.
 *
 * Unlike `IndexRangeBuilder<GenericDocument, string[], number>` (where `.eq()` resolves to plain
 * `IndexRange` due to tuple-length arithmetic on `string[]`), this interface is self-referential:
 * `.eq()` always returns `LooseIndexRangeBuilder`, allowing multi-field `.eq().eq()` chains.
 */
export interface LooseIndexRangeBuilder extends IndexRange {
	eq(fieldName: string, value: Value): LooseIndexRangeBuilder;
	gt(fieldName: string, value: Value): LooseIndexRangeBuilder;
	gte(fieldName: string, value: Value): LooseIndexRangeBuilder;
	lt(fieldName: string, value: Value): IndexRange;
	lte(fieldName: string, value: Value): IndexRange;
}

type TableSchemas<Tables extends GenericConfectSchema> = {
	[TableName in TableNamesInSchema<Tables>]: Schema.Schema<
		DocumentFromTable<Tables, TableName>,
		EncodedDocumentFromTable<Tables, TableName>
	>;
};

interface ConfectQuery<
	Tables extends GenericConfectSchema,
	TableName extends TableNamesInSchema<Tables>,
> {
	filter(
		predicate: (q: FilterBuilder<GenericTableInfo>) => Expression<boolean>,
	): ConfectQuery<Tables, TableName>;

	order(order: "asc" | "desc"): ConfectOrderedQuery<Tables, TableName>;

	paginate(
		paginationOpts: PaginationOptions,
	): Effect.Effect<PaginationResult<DocumentFromTable<Tables, TableName>>>;

	collect(): Effect.Effect<Array<DocumentFromTable<Tables, TableName>>>;

	take(n: number): Effect.Effect<Array<DocumentFromTable<Tables, TableName>>>;

	first(): Effect.Effect<Option.Option<DocumentFromTable<Tables, TableName>>>;

	unique(): Effect.Effect<Option.Option<DocumentFromTable<Tables, TableName>>, NotUniqueError>;

	stream(): Stream.Stream<DocumentFromTable<Tables, TableName>>;
}

interface ConfectOrderedQuery<
	Tables extends GenericConfectSchema,
	TableName extends TableNamesInSchema<Tables>,
> extends Omit<ConfectQuery<Tables, TableName>, "order"> {}

export class NotUniqueError extends Schema.TaggedError<NotUniqueError>()(
	"NotUniqueError",
	{},
) {}

interface QueryLike {
	[Symbol.asyncIterator](): AsyncIterator<Record<string, Value>>;
	filter(predicate: (q: FilterBuilder<GenericTableInfo>) => Expression<boolean>): QueryLike;
	order(order: "asc" | "desc"): QueryLike;
	paginate(opts: PaginationOptions): Promise<PaginationResult<Record<string, Value>>>;
}

interface QueryInitializerLike extends QueryLike {
	fullTableScan(): QueryLike;
	withIndex(indexName: string, indexRange?: (q: LooseIndexRangeBuilder) => IndexRange): QueryLike;
	withSearchIndex(indexName: string, searchFilter: (q: unknown) => SearchFilter): QueryLike;
}

class ConfectQueryImpl<
	Tables extends GenericConfectSchema,
	TableName extends TableNamesInSchema<Tables>,
> implements ConfectQuery<Tables, TableName>
{
	constructor(
		private readonly q: QueryLike,
		private readonly tableSchema: Schema.Schema<
			DocumentFromTable<Tables, TableName>,
			EncodedDocumentFromTable<Tables, TableName>
		>,
		private readonly tableName: TableName,
	) {}

	private decode(doc: Record<string, Value>): DocumentFromTable<Tables, TableName> {
		return Schema.decodeUnknownSync(this.tableSchema)(doc);
	}

	filter(
		predicate: (q: FilterBuilder<GenericTableInfo>) => Expression<boolean>,
	): ConfectQuery<Tables, TableName> {
		return new ConfectQueryImpl(
			this.q.filter(predicate),
			this.tableSchema,
			this.tableName,
		);
	}

	order(order: "asc" | "desc"): ConfectOrderedQuery<Tables, TableName> {
		return new ConfectQueryImpl(
			this.q.order(order),
			this.tableSchema,
			this.tableName,
		);
	}

	paginate(
		paginationOpts: PaginationOptions,
	): Effect.Effect<PaginationResult<DocumentFromTable<Tables, TableName>>> {
		return pipe(
			Effect.promise(() => this.q.paginate(paginationOpts)),
			Effect.map((result) => ({
				...result,
				page: result.page.map((doc) => this.decode(doc)),
			})),
		);
	}

	collect(): Effect.Effect<Array<DocumentFromTable<Tables, TableName>>> {
		return pipe(
			this.stream(),
			Stream.runCollect,
			Effect.map((chunk) => Chunk.toArray(chunk)),
		);
	}

	take(n: number): Effect.Effect<Array<DocumentFromTable<Tables, TableName>>> {
		return pipe(
			this.stream(),
			Stream.take(n),
			Stream.runCollect,
			Effect.map((chunk) => Chunk.toArray(chunk)),
		);
	}

	first(): Effect.Effect<Option.Option<DocumentFromTable<Tables, TableName>>> {
		return pipe(this.stream(), Stream.runHead);
	}

	unique(): Effect.Effect<Option.Option<DocumentFromTable<Tables, TableName>>, NotUniqueError> {
		return pipe(
			this.stream(),
			Stream.take(2),
			Stream.runCollect,
			Effect.flatMap((chunk) => {
				if (Chunk.size(chunk) > 1) {
					return Effect.fail(new NotUniqueError());
				}
				return Effect.succeed(Chunk.get(chunk, 0));
			}),
		);
	}

	stream(): Stream.Stream<DocumentFromTable<Tables, TableName>> {
		return pipe(
			Stream.fromAsyncIterable(this.q, (e) => e as Error),
			Stream.map((doc) => this.decode(doc)),
			Stream.orDie,
		);
	}
}

interface ConfectQueryInitializer<
	Tables extends GenericConfectSchema,
	TableName extends TableNamesInSchema<Tables>,
> extends ConfectQuery<Tables, TableName> {
	fullTableScan(): ConfectQuery<Tables, TableName>;

	withIndex<IndexName extends string>(
		indexName: IndexName,
		indexRange?: (q: LooseIndexRangeBuilder) => IndexRange,
	): ConfectQuery<Tables, TableName>;

	withSearchIndex<IndexName extends string>(
		indexName: IndexName,
		searchFilter: (q: unknown) => SearchFilter,
	): ConfectOrderedQuery<Tables, TableName>;
}

class ConfectQueryInitializerImpl<
	Tables extends GenericConfectSchema,
	TableName extends TableNamesInSchema<Tables>,
> implements ConfectQueryInitializer<Tables, TableName>
{
	constructor(
		private readonly q: QueryInitializerLike,
		private readonly tableSchema: Schema.Schema<
			DocumentFromTable<Tables, TableName>,
			EncodedDocumentFromTable<Tables, TableName>
		>,
		private readonly tableName: TableName,
	) {}

	fullTableScan(): ConfectQuery<Tables, TableName> {
		return new ConfectQueryImpl(
			this.q.fullTableScan(),
			this.tableSchema,
			this.tableName,
		);
	}

	withIndex<IndexName extends string>(
		indexName: IndexName,
		indexRange?: (q: LooseIndexRangeBuilder) => IndexRange,
	): ConfectQuery<Tables, TableName> {
		return new ConfectQueryImpl(
			this.q.withIndex(indexName, indexRange),
			this.tableSchema,
			this.tableName,
		);
	}

	withSearchIndex<IndexName extends string>(
		indexName: IndexName,
		searchFilter: (q: unknown) => SearchFilter,
	): ConfectOrderedQuery<Tables, TableName> {
		return new ConfectQueryImpl(
			this.q.withSearchIndex(indexName, searchFilter),
			this.tableSchema,
			this.tableName,
		);
	}

	filter(
		predicate: (q: FilterBuilder<GenericTableInfo>) => Expression<boolean>,
	): ConfectQuery<Tables, TableName> {
		return this.fullTableScan().filter(predicate);
	}

	order(order: "asc" | "desc"): ConfectOrderedQuery<Tables, TableName> {
		return this.fullTableScan().order(order);
	}

	paginate(
		paginationOpts: PaginationOptions,
	): Effect.Effect<PaginationResult<DocumentFromTable<Tables, TableName>>> {
		return this.fullTableScan().paginate(paginationOpts);
	}

	collect(): Effect.Effect<Array<DocumentFromTable<Tables, TableName>>> {
		return this.fullTableScan().collect();
	}

	take(n: number): Effect.Effect<Array<DocumentFromTable<Tables, TableName>>> {
		return this.fullTableScan().take(n);
	}

	first(): Effect.Effect<Option.Option<DocumentFromTable<Tables, TableName>>> {
		return this.fullTableScan().first();
	}

	unique(): Effect.Effect<Option.Option<DocumentFromTable<Tables, TableName>>, NotUniqueError> {
		return this.fullTableScan().unique();
	}

	stream(): Stream.Stream<DocumentFromTable<Tables, TableName>> {
		return this.fullTableScan().stream();
	}
}

export interface ConfectDatabaseReader<Tables extends GenericConfectSchema> {
	query<TableName extends TableNamesInSchema<Tables>>(
		tableName: TableName,
	): ConfectQueryInitializer<Tables, TableName>;

	get<TableName extends TableNamesInSchema<Tables>>(
		id: GenericId<TableName>,
	): Effect.Effect<Option.Option<DocumentFromTable<Tables, TableName>>>;

	normalizeId<TableName extends TableNamesInSchema<Tables>>(
		tableName: TableName,
		id: string,
	): Option.Option<GenericId<TableName>>;
}

export interface ConfectDatabaseWriter<Tables extends GenericConfectSchema>
	extends ConfectDatabaseReader<Tables> {
	insert<TableName extends TableNamesInSchema<Tables>>(
		table: TableName,
		value: WithoutSystemFields<DocumentFromTable<Tables, TableName>>,
	): Effect.Effect<GenericId<TableName>>;

	patch<TableName extends TableNamesInSchema<Tables>>(
		id: GenericId<TableName>,
		value: Partial<WithoutSystemFields<DocumentFromTable<Tables, TableName>>>,
	): Effect.Effect<void>;

	replace<TableName extends TableNamesInSchema<Tables>>(
		id: GenericId<TableName>,
		value: WithoutSystemFields<DocumentFromTable<Tables, TableName>>,
	): Effect.Effect<void>;

	delete(id: GenericId<string>): Effect.Effect<void>;
}

class ConfectDatabaseReaderImpl<Tables extends GenericConfectSchema>
	implements ConfectDatabaseReader<Tables>
{
	constructor(
		protected readonly db: GenericDatabaseReader<GenericDataModel>,
		protected readonly tableSchemas: TableSchemas<Tables>,
	) {}

	protected decode<TableName extends TableNamesInSchema<Tables>>(
		tableName: TableName,
		doc: Record<string, Value>,
	): DocumentFromTable<Tables, TableName> {
		return Schema.decodeUnknownSync(this.tableSchemas[tableName])(doc);
	}

	query<TableName extends TableNamesInSchema<Tables>>(
		tableName: TableName,
	): ConfectQueryInitializer<Tables, TableName> {
		return new ConfectQueryInitializerImpl(
			this.db.query(tableName) as unknown as QueryInitializerLike,
			this.tableSchemas[tableName],
			tableName,
		);
	}

	get<TableName extends TableNamesInSchema<Tables>>(
		id: GenericId<TableName>,
	): Effect.Effect<Option.Option<DocumentFromTable<Tables, TableName>>> {
		return pipe(
			Effect.promise(() => this.db.get(id)),
			Effect.map((doc) => {
				if (doc === null) {
					return Option.none<DocumentFromTable<Tables, TableName>>();
				}
				const tableName = this.getTableNameFromId(id);
				if (Option.isNone(tableName)) {
					return Option.none<DocumentFromTable<Tables, TableName>>();
				}
				return Option.some(this.decode(tableName.value, doc as Record<string, Value>));
			}),
		);
	}

	normalizeId<TableName extends TableNamesInSchema<Tables>>(
		tableName: TableName,
		id: string,
	): Option.Option<GenericId<TableName>> {
		const normalized = this.db.normalizeId(tableName, id);
		return Option.fromNullable(normalized);
	}

	private getTableNameFromId<TableName extends TableNamesInSchema<Tables>>(
		id: GenericId<TableName>,
	): Option.Option<TableName> {
		for (const tableName of Object.keys(this.tableSchemas)) {
			const normalized = this.db.normalizeId(tableName, id);
			if (normalized !== null) {
				return Option.some(tableName as TableName);
			}
		}
		return Option.none();
	}
}

class ConfectDatabaseWriterImpl<Tables extends GenericConfectSchema>
	extends ConfectDatabaseReaderImpl<Tables>
	implements ConfectDatabaseWriter<Tables>
{
	constructor(
		protected override readonly db: GenericDatabaseWriter<GenericDataModel>,
		tableSchemas: TableSchemas<Tables>,
	) {
		super(db, tableSchemas);
	}

	insert<TableName extends TableNamesInSchema<Tables>>(
		table: TableName,
		value: WithoutSystemFields<DocumentFromTable<Tables, TableName>>,
	): Effect.Effect<GenericId<TableName>> {
		return Effect.promise(() =>
			(this.db as GenericDatabaseWriter<GenericDataModel>).insert(
				table,
				value as Record<string, Value>,
			),
		) as Effect.Effect<GenericId<TableName>>;
	}

	patch<TableName extends TableNamesInSchema<Tables>>(
		id: GenericId<TableName>,
		value: Partial<WithoutSystemFields<DocumentFromTable<Tables, TableName>>>,
	): Effect.Effect<void> {
		return Effect.promise(() =>
			(this.db as GenericDatabaseWriter<GenericDataModel>).patch(
				id,
				value as Record<string, Value>,
			),
		);
	}

	replace<TableName extends TableNamesInSchema<Tables>>(
		id: GenericId<TableName>,
		value: WithoutSystemFields<DocumentFromTable<Tables, TableName>>,
	): Effect.Effect<void> {
		return Effect.promise(() =>
			(this.db as GenericDatabaseWriter<GenericDataModel>).replace(
				id,
				value as Record<string, Value>,
			),
		);
	}

	delete(id: GenericId<string>): Effect.Effect<void> {
		return Effect.promise(() =>
			(this.db as GenericDatabaseWriter<GenericDataModel>).delete(id),
		);
	}
}

export interface ConfectAuth {
	getUserIdentity(): Effect.Effect<Option.Option<{
		tokenIdentifier: string;
		subject: string;
		issuer: string;
		[key: string]: unknown;
	}>>;
}

class ConfectAuthImpl implements ConfectAuth {
	constructor(private readonly auth: { getUserIdentity: () => Promise<unknown> }) {}

	getUserIdentity(): Effect.Effect<Option.Option<{
		tokenIdentifier: string;
		subject: string;
		issuer: string;
		[key: string]: unknown;
	}>> {
		return pipe(
			Effect.promise(() => this.auth.getUserIdentity()),
			Effect.map((identity) =>
				identity
					? Option.some(
							identity as {
								tokenIdentifier: string;
								subject: string;
								issuer: string;
								[key: string]: unknown;
							},
						)
					: Option.none(),
			),
		);
	}
}

/**
 * Unwrap `ExitEncoded<A, E, D>` to just `A` at the type level.
 *
 * Confect-registered functions return `ExitEncoded` on the wire, so
 * `FunctionReturnType<Ref>` resolves to `ExitEncoded<A, E, D>`.
 * This utility type extracts the success value `A` so that
 * `yield* ctx.runQuery(...)` gives you the logical return type.
 *
 * For non-Confect functions (plain Convex), the type passes through unchanged.
 */
type UnwrapExitEncoded<T> =
	// Use Extract to isolate the Success branch of the ExitEncoded union
	Extract<T, { readonly _tag: "Success" }> extends {
		readonly _tag: "Success";
		readonly value: infer A;
	}
		? A
		: T;

export interface ConfectQueryCtx<Tables extends GenericConfectSchema> {
	runQuery<Query extends FunctionReference<"query", "public" | "internal">>(
		query: Query,
		...args: OptionalRestArgs<Query>
	): Effect.Effect<UnwrapExitEncoded<FunctionReturnType<Query>>>;

	db: ConfectDatabaseReader<Tables>;
	auth: ConfectAuth;

	/**
	 * The raw Convex query context, useful for passing to Convex components
	 * (e.g. `@convex-dev/aggregate`) that expect standard Convex context objects.
	 */
	rawCtx: GenericQueryCtx<GenericDataModel>;
}

export interface ConfectMutationCtx<Tables extends GenericConfectSchema> {
	runQuery<Query extends FunctionReference<"query", "public" | "internal">>(
		query: Query,
		...args: OptionalRestArgs<Query>
	): Effect.Effect<UnwrapExitEncoded<FunctionReturnType<Query>>>;

	runMutation<Mutation extends FunctionReference<"mutation", "public" | "internal">>(
		mutation: Mutation,
		...args: OptionalRestArgs<Mutation>
	): Effect.Effect<UnwrapExitEncoded<FunctionReturnType<Mutation>>>;

	/** Raw Convex scheduler for scheduling functions from mutations. */
	scheduler: Scheduler;

	db: ConfectDatabaseWriter<Tables>;
	auth: ConfectAuth;

	/**
	 * The raw Convex mutation context, useful for passing to Convex components
	 * (e.g. `@convex-dev/aggregate`) that expect standard Convex context objects.
	 */
	rawCtx: GenericMutationCtx<GenericDataModel>;
}

export interface ConfectActionCtx<Tables extends GenericConfectSchema> {
	runQuery<Query extends FunctionReference<"query", "public" | "internal">>(
		query: Query,
		...args: OptionalRestArgs<Query>
	): Effect.Effect<UnwrapExitEncoded<FunctionReturnType<Query>>>;

	runMutation<Mutation extends FunctionReference<"mutation", "public" | "internal">>(
		mutation: Mutation,
		...args: OptionalRestArgs<Mutation>
	): Effect.Effect<UnwrapExitEncoded<FunctionReturnType<Mutation>>>;

	runAction<Action extends FunctionReference<"action", "public" | "internal">>(
		action: Action,
		...args: OptionalRestArgs<Action>
	): Effect.Effect<UnwrapExitEncoded<FunctionReturnType<Action>>>;

	scheduler: Scheduler;
	auth: ConfectAuth;
}

export const ConfectQueryCtx = <Tables extends GenericConfectSchema>() =>
	Context.GenericTag<ConfectQueryCtx<Tables>>("@confect/ConfectQueryCtx");

export const ConfectMutationCtx = <Tables extends GenericConfectSchema>() =>
	Context.GenericTag<ConfectMutationCtx<Tables>>("@confect/ConfectMutationCtx");

export const ConfectActionCtx = <Tables extends GenericConfectSchema>() =>
	Context.GenericTag<ConfectActionCtx<Tables>>("@confect/ConfectActionCtx");

export const makeQueryCtx = <Tables extends GenericConfectSchema>(
	ctx: GenericQueryCtx<GenericDataModel>,
	tableSchemas: TableSchemas<Tables>,
): ConfectQueryCtx<Tables> => ({
	runQuery: <Query extends FunctionReference<"query", "public" | "internal">>(
		query: Query,
		...args: OptionalRestArgs<Query>
	) =>
		Effect.promise(() => ctx.runQuery(query, ...args)).pipe(
			Effect.flatMap(unwrapIfExitEncoded),
		),
	db: new ConfectDatabaseReaderImpl(ctx.db, tableSchemas),
	auth: new ConfectAuthImpl(ctx.auth),
	rawCtx: ctx,
});

export const makeMutationCtx = <Tables extends GenericConfectSchema>(
	ctx: GenericMutationCtx<GenericDataModel>,
	tableSchemas: TableSchemas<Tables>,
): ConfectMutationCtx<Tables> => ({
	runQuery: <Query extends FunctionReference<"query", "public" | "internal">>(
		query: Query,
		...args: OptionalRestArgs<Query>
	) =>
		Effect.promise(() => ctx.runQuery(query, ...args)).pipe(
			Effect.flatMap(unwrapIfExitEncoded),
		),
	runMutation: <Mutation extends FunctionReference<"mutation", "public" | "internal">>(
		mutation: Mutation,
		...args: OptionalRestArgs<Mutation>
	) =>
		Effect.promise(() => ctx.runMutation(mutation, ...args)).pipe(
			Effect.flatMap(unwrapIfExitEncoded),
		),
	scheduler: ctx.scheduler,
	db: new ConfectDatabaseWriterImpl(ctx.db, tableSchemas),
	auth: new ConfectAuthImpl(ctx.auth),
	rawCtx: ctx,
});

/**
 * Detect and unwrap Confect ExitEncoded results from cross-function calls.
 *
 * When a Confect action/mutation/query calls another Confect function via
 * `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction`, the raw Convex runtime
 * returns the function's wire format — which for Confect functions is
 * `ExitEncoded<Success, Error>` (a tagged union `{_tag: "Success", value}` |
 * `{_tag: "Failure", cause}`).
 *
 * Without unwrapping, `yield* ctx.runQuery(...)` gives you the raw ExitEncoded
 * object instead of the logical success value, forcing users to manually check
 * `_tag` and extract `.value`. This helper makes cross-function calls
 * transparent: Success values are extracted, Failure causes become Effect failures.
 */
const unwrapIfExitEncoded = <T>(result: T): Effect.Effect<T> => {
	if (
		typeof result === "object" &&
		result !== null &&
		"_tag" in result
	) {
		const tagged = result as { _tag: string; value?: unknown; cause?: unknown };
		if (tagged._tag === "Success") {
			return Effect.succeed(tagged.value as T);
		}
		if (tagged._tag === "Failure") {
			// Re-throw as an Effect failure so the caller's error channel catches it
			return Effect.die(tagged.cause);
		}
	}
	// Not an ExitEncoded — return as-is (e.g. plain Convex functions)
	return Effect.succeed(result);
};

export const makeActionCtx = <Tables extends GenericConfectSchema>(
	ctx: GenericActionCtx<GenericDataModel>,
): ConfectActionCtx<Tables> => ({
	runQuery: <Query extends FunctionReference<"query", "public" | "internal">>(
		query: Query,
		...args: OptionalRestArgs<Query>
	) =>
		Effect.promise(() => ctx.runQuery(query, ...args)).pipe(
			Effect.flatMap(unwrapIfExitEncoded),
		),
	runMutation: <Mutation extends FunctionReference<"mutation", "public" | "internal">>(
		mutation: Mutation,
		...args: OptionalRestArgs<Mutation>
	) =>
		Effect.promise(() => ctx.runMutation(mutation, ...args)).pipe(
			Effect.flatMap(unwrapIfExitEncoded),
		),
	runAction: <Action extends FunctionReference<"action", "public" | "internal">>(
		action: Action,
		...args: OptionalRestArgs<Action>
	) =>
		Effect.promise(() => ctx.runAction(action, ...args)).pipe(
			Effect.flatMap(unwrapIfExitEncoded),
		),
	scheduler: ctx.scheduler,
	auth: new ConfectAuthImpl(ctx.auth),
});
