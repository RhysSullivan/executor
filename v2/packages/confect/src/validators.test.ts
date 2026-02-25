import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
	schemaToValidator,
	schemaToObjectValidator,
	Id,
	TopLevelMustBeObjectError,
	IndexSignaturesNotSupportedError,
} from "./validators";

const getKind = (validator: unknown): string =>
	(validator as { kind: string }).kind;

const getValue = (validator: unknown): unknown =>
	(validator as { value: unknown }).value;

const getTableName = (validator: unknown): string =>
	(validator as { tableName: string }).tableName;

const getIsOptional = (validator: unknown): string =>
	(validator as { isOptional: string }).isOptional;

describe("validators", () => {
	describe("schemaToValidator", () => {
		describe("primitive types", () => {
			it("converts Schema.String to v.string()", () => {
				const validator = schemaToValidator(Schema.String);
				expect(getKind(validator)).toBe("string");
			});

			it("converts Schema.Number to v.float64()", () => {
				const validator = schemaToValidator(Schema.Number);
				expect(getKind(validator)).toBe("float64");
			});

			it("converts Schema.Boolean to v.boolean()", () => {
				const validator = schemaToValidator(Schema.Boolean);
				expect(getKind(validator)).toBe("boolean");
			});

			it("converts Schema.BigInt to v.int64()", () => {
				const validator = schemaToValidator(Schema.BigIntFromSelf);
				expect(getKind(validator)).toBe("int64");
			});

			it("converts Schema.Null to v.null()", () => {
				const validator = schemaToValidator(Schema.Null);
				expect(getKind(validator)).toBe("null");
			});
		});

		describe("literal types", () => {
			it("converts string literal", () => {
				const validator = schemaToValidator(Schema.Literal("hello"));
				expect(getKind(validator)).toBe("literal");
				expect(getValue(validator)).toBe("hello");
			});

			it("converts number literal", () => {
				const validator = schemaToValidator(Schema.Literal(42));
				expect(getKind(validator)).toBe("literal");
				expect(getValue(validator)).toBe(42);
			});

			it("converts boolean literal", () => {
				const validator = schemaToValidator(Schema.Literal(true));
				expect(getKind(validator)).toBe("literal");
				expect(getValue(validator)).toBe(true);
			});
		});

		describe("object types", () => {
			it("converts simple struct", () => {
				const schema = Schema.Struct({
					name: Schema.String,
					age: Schema.Number,
				});
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("object");
			});

			it("converts nested struct", () => {
				const schema = Schema.Struct({
					user: Schema.Struct({
						name: Schema.String,
						email: Schema.String,
					}),
					active: Schema.Boolean,
				});
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("object");
			});

			it("handles optional fields", () => {
				const schema = Schema.Struct({
					required: Schema.String,
					optional: Schema.optional(Schema.String),
				});
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("object");
			});
		});

		describe("array types", () => {
			it("converts array of primitives", () => {
				const schema = Schema.Array(Schema.String);
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("array");
			});

			it("converts array of objects", () => {
				const schema = Schema.Array(
					Schema.Struct({
						id: Schema.String,
						value: Schema.Number,
					}),
				);
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("array");
			});
		});

		describe("union types", () => {
			it("converts union of primitives", () => {
				const schema = Schema.Union(Schema.String, Schema.Number);
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("union");
			});

			it("converts union of literals", () => {
				const schema = Schema.Union(
					Schema.Literal("active"),
					Schema.Literal("inactive"),
					Schema.Literal("pending"),
				);
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("union");
			});

			it("converts nullable types", () => {
				const schema = Schema.NullOr(Schema.String);
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("union");
			});
		});

		describe("Id type", () => {
			it("converts Id schema to v.id()", () => {
				const schema = Id("users");
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("id");
				expect(getTableName(validator)).toBe("users");
			});

			it("works with different table names", () => {
				const postsId = Id("posts");
				const commentsId = Id("comments");

				const postsValidator = schemaToValidator(postsId);
				const commentsValidator = schemaToValidator(commentsId);

				expect(getTableName(postsValidator)).toBe("posts");
				expect(getTableName(commentsValidator)).toBe("comments");
			});
		});

		describe("refinement types", () => {
			it("unwraps refinements to base type", () => {
				const schema = Schema.String.pipe(Schema.minLength(1));
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("string");
			});

			it("unwraps multiple refinements", () => {
				const schema = Schema.Number.pipe(Schema.positive(), Schema.int());
				const validator = schemaToValidator(schema);
				expect(getKind(validator)).toBe("float64");
			});
		});

		describe("any/unknown types", () => {
			it("converts Schema.Unknown to v.any()", () => {
				const validator = schemaToValidator(Schema.Unknown);
				expect(getKind(validator)).toBe("any");
			});

			it("converts Schema.Any to v.any()", () => {
				const validator = schemaToValidator(Schema.Any);
				expect(getKind(validator)).toBe("any");
			});
		});
	});

	describe("schemaToObjectValidator", () => {
		it("extracts fields from struct schema", () => {
			const schema = Schema.Struct({
				name: Schema.String,
				count: Schema.Number,
			});
			const fields = schemaToObjectValidator(schema);

			expect(fields.name).toBeDefined();
			expect(fields.count).toBeDefined();
		});

		it("marks optional fields correctly", () => {
			const schema = Schema.Struct({
				required: Schema.String,
				optional: Schema.optional(Schema.Number),
			});
			const fields = schemaToObjectValidator(schema);

			expect(getIsOptional(fields.required)).toBe("required");
			expect(getIsOptional(fields.optional)).toBe("optional");
		});

		it("throws TopLevelMustBeObjectError for non-object schemas", () => {
			const schema = Schema.String;
			expect(() => schemaToObjectValidator(schema)).toThrow(
				TopLevelMustBeObjectError,
			);
		});

		it("throws IndexSignaturesNotSupportedError for record types", () => {
			const schema = Schema.Record({
				key: Schema.String,
				value: Schema.Number,
			});
			expect(() => schemaToObjectValidator(schema)).toThrow(
				IndexSignaturesNotSupportedError,
			);
		});
	});

	describe("Id helper", () => {
		it("creates a branded string schema", () => {
			const UserId = Id("users");
			const decoded = Schema.decodeSync(UserId)("user_123");
			expect(decoded).toBe("user_123");
		});

		it("includes table name in identifier annotation", () => {
			const UserId = Id("users");
			expect(UserId.ast.annotations).toBeDefined();
		});
	});
});
