import * as Schema from "effect/Schema";

export const Cursor = Schema.String.pipe(Schema.brand("Cursor"));
export type Cursor = typeof Cursor.Type;

export const PaginationOptionsSchema = Schema.Struct({
	cursor: Schema.NullOr(Cursor),
	numItems: Schema.Number,
});
export type PaginationOptionsSchema = typeof PaginationOptionsSchema.Type;

export const PaginationResultSchema = <Item extends Schema.Schema.AnyNoContext>(
	item: Item,
) =>
	Schema.Struct({
		page: Schema.Array(item),
		isDone: Schema.Boolean,
		continueCursor: Cursor,
	});
