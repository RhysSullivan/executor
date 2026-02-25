import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { defineTable, defineSchema, type ConfectTableDefinition } from "./schema";

describe("schema", () => {
	describe("defineTable", () => {
		it("creates a table definition from Effect Schema", () => {
			const userTable = defineTable(
				Schema.Struct({
					name: Schema.String,
					email: Schema.String,
				}),
			);

			expect(userTable).toBeDefined();
			expect(userTable.tableDefinition).toBeDefined();
			expect(userTable.tableSchema).toBeDefined();
			expect(userTable.documentSchema).toBeDefined();
		});

		it("includes system fields in documentSchema", () => {
			const postTable = defineTable(
				Schema.Struct({
					title: Schema.String,
					content: Schema.String,
				}),
			);

			const doc = {
				_id: "123",
				_creationTime: Date.now(),
				title: "Hello",
				content: "World",
			};

			const result = Schema.decodeUnknownSync(postTable.documentSchema)(doc);
			expect(result).toMatchObject({
				_id: "123",
				title: "Hello",
				content: "World",
			});
		});

		describe("index", () => {
			it("adds an index to the table definition", () => {
				const table = defineTable(
					Schema.Struct({
						userId: Schema.String,
						createdAt: Schema.Number,
					}),
				).index("by_userId", ["userId"]);

				expect(table).toBeDefined();
			});

			it("supports compound indexes", () => {
				const table = defineTable(
					Schema.Struct({
						userId: Schema.String,
						status: Schema.String,
						createdAt: Schema.Number,
					}),
				).index("by_userId_and_status", ["userId", "status"]);

				expect(table).toBeDefined();
			});

			it("allows chaining multiple indexes", () => {
				const table = defineTable(
					Schema.Struct({
						userId: Schema.String,
						email: Schema.String,
					}),
				)
					.index("by_userId", ["userId"])
					.index("by_email", ["email"]);

				expect(table).toBeDefined();
			});
		});

		describe("searchIndex", () => {
			it("adds a search index to the table definition", () => {
				const table = defineTable(
					Schema.Struct({
						title: Schema.String,
						content: Schema.String,
					}),
				).searchIndex("search_content", {
					searchField: "content",
					filterFields: [],
				});

				expect(table).toBeDefined();
			});
		});

		describe("vectorIndex", () => {
			it("adds a vector index to the table definition", () => {
				const table = defineTable(
					Schema.Struct({
						embedding: Schema.Array(Schema.Number),
						category: Schema.String,
					}),
				).vectorIndex("by_embedding", {
					vectorField: "embedding",
					dimensions: 1536,
					filterFields: ["category"],
				});

				expect(table).toBeDefined();
			});
		});
	});

	describe("defineSchema", () => {
		it("creates a schema definition from multiple tables", () => {
			const schema = defineSchema({
				users: defineTable(
					Schema.Struct({
						name: Schema.String,
						email: Schema.String,
					}),
				),
				posts: defineTable(
					Schema.Struct({
						title: Schema.String,
						authorId: Schema.String,
					}),
				),
			});

			expect(schema.tables.users).toBeDefined();
			expect(schema.tables.posts).toBeDefined();
			expect(schema.convexSchemaDefinition).toBeDefined();
		});

		it("preserves table definitions in the tables property", () => {
			const userTable = defineTable(
				Schema.Struct({
					name: Schema.String,
				}),
			);

			const schema = defineSchema({
				users: userTable,
			});

			expect(schema.tables.users).toBe(userTable);
		});

		it("creates convex-compatible schema definition", () => {
			const schema = defineSchema({
				items: defineTable(
					Schema.Struct({
						name: Schema.String,
						quantity: Schema.Number,
					}),
				),
			});

			expect(schema.convexSchemaDefinition).toBeDefined();
			expect(schema.convexSchemaDefinition.tables).toBeDefined();
		});

		it("handles complex nested schemas", () => {
			const schema = defineSchema({
				orders: defineTable(
					Schema.Struct({
						items: Schema.Array(
							Schema.Struct({
								productId: Schema.String,
								quantity: Schema.Number,
								price: Schema.Number,
							}),
						),
						status: Schema.Union(
							Schema.Literal("pending"),
							Schema.Literal("confirmed"),
							Schema.Literal("shipped"),
							Schema.Literal("delivered"),
						),
						metadata: Schema.optional(
							Schema.Struct({
								notes: Schema.String,
							}),
						),
					}),
				),
			});

			expect(schema.tables.orders).toBeDefined();
		});
	});

	describe("type inference", () => {
		it("correctly infers document type with system fields", () => {
			const table = defineTable(
				Schema.Struct({
					name: Schema.String,
					age: Schema.Number,
				}),
			);

			const validDoc = {
				_id: "doc123",
				_creationTime: 1234567890,
				name: "Alice",
				age: 30,
			};

			const decoded = Schema.decodeUnknownSync(table.documentSchema)(validDoc);
			expect(decoded).toEqual(validDoc);
		});

		it("rejects documents missing required fields", () => {
			const table = defineTable(
				Schema.Struct({
					name: Schema.String,
					required: Schema.String,
				}),
			);

			const invalidDoc = {
				_id: "doc123",
				_creationTime: 1234567890,
				name: "Alice",
			};

			expect(() =>
				Schema.decodeUnknownSync(table.documentSchema)(invalidDoc),
			).toThrow();
		});
	});
});
