import { v } from "convex/values";
import type { GenericId, Validator } from "convex/values";
import { Data, Option, Schema, SchemaAST } from "effect";

const getIdTableName = (ast: SchemaAST.AST): Option.Option<string> => {
	const annotations = ast.annotations;
	const identifier = annotations[SchemaAST.IdentifierAnnotationId];
	if (typeof identifier === "string" && identifier.startsWith("Id<")) {
		const match = identifier.match(/^Id<"?([^">]+)"?>$/);
		if (match?.[1]) {
			return Option.some(match[1]);
		}
	}
	return Option.none();
};

export class UnsupportedSchemaError extends Data.TaggedError("UnsupportedSchemaError")<{
	readonly schemaType: string;
}> {}

export class TopLevelMustBeObjectError extends Data.TaggedError("TopLevelMustBeObjectError")<{}> {}

export class IndexSignaturesNotSupportedError extends Data.TaggedError(
	"IndexSignaturesNotSupportedError",
)<{}> {}

type AnyValidator = Validator<unknown, "required" | "optional", string>;
type RequiredValidator = Validator<unknown, "required", string>;

const compileAst = (
	ast: SchemaAST.AST,
	isOptionalProperty = false,
): AnyValidator => {
	switch (ast._tag) {
		case "Literal": {
			const literal = ast.literal;
			if (literal === null) {
				return v.null();
			}
			if (typeof literal === "string" || typeof literal === "number" || typeof literal === "bigint" || typeof literal === "boolean") {
				return v.literal(literal);
			}
			throw new UnsupportedSchemaError({ schemaType: "Literal" });
		}

		case "BooleanKeyword":
			return v.boolean();

		case "StringKeyword": {
			const tableName = getIdTableName(ast);
			if (Option.isSome(tableName)) {
				return v.id(tableName.value);
			}
			return v.string();
		}

		case "NumberKeyword":
			return v.float64();

		case "BigIntKeyword":
			return v.int64();

		case "Union":
			return handleUnion(ast, isOptionalProperty);

		case "TypeLiteral":
			return handleTypeLiteral(ast);

		case "TupleType":
			return handleTupleType(ast);

		case "UnknownKeyword":
		case "AnyKeyword":
			return v.any();

		case "Refinement":
			return compileAst(ast.from);

		case "Suspend":
			return v.any();

		case "Declaration":
			return v.bytes();

		default:
			throw new UnsupportedSchemaError({ schemaType: ast._tag });
	}
};

const handleUnion = (
	unionAst: SchemaAST.Union,
	isOptionalProperty: boolean,
): AnyValidator => {
	const types = unionAst.types;
	const filteredTypes = isOptionalProperty
		? types.filter((type) => !SchemaAST.isUndefinedKeyword(type))
		: types;

	const validators: Array<AnyValidator> = [];
	for (const type of filteredTypes) {
		validators.push(compileAst(type));
	}

	if (validators.length === 0) {
		return v.any();
	}
	if (validators.length === 1) {
		return validators[0]!;
	}

	const [first, second, ...rest] = validators;
	return v.union(
		first as RequiredValidator,
		second as RequiredValidator,
		...(rest as Array<RequiredValidator>),
	);
};

const handleTypeLiteral = (
	typeLiteralAst: SchemaAST.TypeLiteral,
): AnyValidator => {
	if (typeLiteralAst.indexSignatures.length > 0) {
		throw new IndexSignaturesNotSupportedError();
	}

	const fields: Record<string, AnyValidator> = {};

	for (const prop of typeLiteralAst.propertySignatures) {
		if (typeof prop.name !== "string") {
			continue;
		}

		const validator = compileAst(prop.type, prop.isOptional);
		fields[prop.name] = prop.isOptional ? v.optional(validator) : validator;
	}

	return v.object(fields);
};

const handleTupleType = (
	tupleTypeAst: SchemaAST.TupleType,
): AnyValidator => {
	const { elements, rest } = tupleTypeAst;

	if (elements.length === 0 && rest.length > 0) {
		const itemValidator = compileAst(rest[0]!.type);
		return v.array(itemValidator as RequiredValidator);
	}

	if (elements.length > 0) {
		const elementValidators: Array<AnyValidator> = [];
		for (const el of elements) {
			elementValidators.push(compileAst(el.type));
		}

		if (elementValidators.length === 1) {
			return v.array(elementValidators[0] as RequiredValidator);
		}

		const [first, second, ...restValidators] = elementValidators;
		return v.array(
			v.union(
				first as RequiredValidator,
				second as RequiredValidator,
				...(restValidators as Array<RequiredValidator>),
			),
		);
	}

	return v.array(v.any());
};

export const schemaToValidator = <S extends Schema.Schema.AnyNoContext>(
	schema: S,
): Validator<S["Encoded"], "required", string> => {
	const ast = Schema.encodedSchema(schema).ast;
	return compileAst(ast) as Validator<S["Encoded"], "required", string>;
};

type IdSchema<TableName extends string> = Schema.Schema<
	GenericId<TableName>,
	string
>;

export const Id: <TableName extends string>(
	tableName: TableName,
) => IdSchema<TableName> = <TableName extends string>(tableName: TableName) =>
	Schema.String.annotations({
		identifier: `Id<${tableName}>`,
	}) as unknown as IdSchema<TableName>;

export const schemaToObjectValidator = <S extends Schema.Schema.AnyNoContext>(
	schema: S,
): Record<string, Validator<unknown, "required" | "optional", string>> => {
	const ast = Schema.encodedSchema(schema).ast;

	if (ast._tag !== "TypeLiteral") {
		throw new TopLevelMustBeObjectError();
	}

	if (ast.indexSignatures.length > 0) {
		throw new IndexSignaturesNotSupportedError();
	}

	const fields: Record<string, AnyValidator> = {};

	for (const prop of ast.propertySignatures) {
		if (typeof prop.name !== "string") {
			continue;
		}

		const validator = compileAst(prop.type, prop.isOptional);
		fields[prop.name] = prop.isOptional ? v.optional(validator) : validator;
	}

	return fields;
};
