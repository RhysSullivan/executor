/**
 * Integration test: OpenAPI tools → runner sandbox execution.
 *
 * Uses JSONPlaceholder (https://jsonplaceholder.typicode.com) — a free,
 * no-auth REST API — with an inline OpenAPI spec.
 */

import { describe, test, expect } from "bun:test";
import {
  createRunner,
  generateToolDeclarations,
  typecheckCode,
} from "@openassistant/core";
import { generateOpenApiTools } from "./openapi.js";

const jsonPlaceholderSpec = {
  openapi: "3.0.0",
  info: { title: "JSONPlaceholder", version: "1.0.0" },
  servers: [{ url: "https://jsonplaceholder.typicode.com" }],
  paths: {
    "/posts": {
      get: {
        tags: ["posts"],
        operationId: "listPosts",
        summary: "List all posts",
        parameters: [
          {
            name: "_limit",
            in: "query",
            required: false,
            schema: { type: "integer" },
            description: "Limit the number of results",
          },
          {
            name: "userId",
            in: "query",
            required: false,
            schema: { type: "integer" },
            description: "Filter by user ID",
          },
        ],
        responses: {
          "200": {
            description: "A list of posts",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      userId: { type: "integer" },
                      id: { type: "integer" },
                      title: { type: "string" },
                      body: { type: "string" },
                    },
                    required: ["userId", "id", "title", "body"],
                  },
                },
              },
            },
          },
        },
      },
    },
    "/posts/{id}": {
      get: {
        tags: ["posts"],
        operationId: "getPost",
        summary: "Get a post by ID",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
            description: "Post ID",
          },
        ],
        responses: {
          "200": {
            description: "A post",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    userId: { type: "integer" },
                    id: { type: "integer" },
                    title: { type: "string" },
                    body: { type: "string" },
                  },
                  required: ["userId", "id", "title", "body"],
                },
              },
            },
          },
        },
      },
    },
    "/users": {
      get: {
        tags: ["users"],
        operationId: "listUsers",
        summary: "List all users",
        parameters: [],
        responses: {
          "200": {
            description: "A list of users",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      name: { type: "string" },
                      email: { type: "string" },
                    },
                    required: ["id", "name", "email"],
                  },
                },
              },
            },
          },
        },
      },
    },
    "/users/{id}": {
      get: {
        tags: ["users"],
        operationId: "getUser",
        summary: "Get a user by ID",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "A user",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                    email: { type: "string" },
                  },
                  required: ["id", "name", "email"],
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("OpenAPI → runner integration", () => {
  test("generated OpenAPI tools are callable from the sandbox", async () => {
    const result = await generateOpenApiTools({
      name: "placeholder",
      spec: jsonPlaceholderSpec as unknown as string,
    });

    const runner = createRunner({
      tools: result.tools,
      requestApproval: async () => "approved",
      timeoutMs: 15_000,
    });

    // Call the real JSONPlaceholder API from the sandbox
    const runResult = await runner.run(
      `const post = await tools.placeholder.posts.getPost({ id: 1 });\nreturn post;`,
    );

    expect(runResult.ok).toBe(true);
    expect(runResult.value).toBeDefined();

    const post = runResult.value as { id: number; userId: number; title: string };
    expect(post.id).toBe(1);
    expect(post.userId).toBe(1);
    expect(typeof post.title).toBe("string");

    expect(runResult.receipts).toHaveLength(1);
    expect(runResult.receipts[0]!.toolPath).toBe("placeholder.posts.getPost");
    expect(runResult.receipts[0]!.status).toBe("succeeded");
  }, { timeout: 15_000 });

  test("chained OpenAPI calls work in the sandbox", async () => {
    const result = await generateOpenApiTools({
      name: "placeholder",
      spec: jsonPlaceholderSpec as unknown as string,
    });

    const runner = createRunner({
      tools: result.tools,
      requestApproval: async () => "approved",
      timeoutMs: 15_000,
    });

    // Get a user, then get their posts
    const runResult = await runner.run(`
      const user = await tools.placeholder.users.getUser({ id: 1 });
      const posts = await tools.placeholder.posts.listPosts({ userId: 1, _limit: 3 });
      return { userName: user.name, postCount: posts.length };
    `);

    expect(runResult.ok).toBe(true);

    const value = runResult.value as { userName: string; postCount: number };
    expect(value.userName).toBe("Leanne Graham");
    expect(value.postCount).toBe(3);

    expect(runResult.receipts).toHaveLength(2);
    expect(runResult.receipts[0]!.toolPath).toBe("placeholder.users.getUser");
    expect(runResult.receipts[1]!.toolPath).toBe("placeholder.posts.listPosts");
  }, { timeout: 15_000 });

  test("type declarations + typechecker work for generated OpenAPI tools", async () => {
    const result = await generateOpenApiTools({
      name: "placeholder",
      spec: jsonPlaceholderSpec as unknown as string,
    });

    const declarations = generateToolDeclarations(result.tools);

    // Valid code passes
    const validResult = typecheckCode(
      `const post = await tools.placeholder.posts.getPost({ id: 1 });\nreturn post;`,
      declarations,
    );
    expect(validResult.ok).toBe(true);

    // Invalid tool name fails
    const invalidResult = typecheckCode(
      `await tools.placeholder.posts.deleteSomething({ id: 1 });`,
      declarations,
    );
    expect(invalidResult.ok).toBe(false);
  }, { timeout: 15_000 });

  test("loop over API results in the sandbox", async () => {
    const result = await generateOpenApiTools({
      name: "placeholder",
      spec: jsonPlaceholderSpec as unknown as string,
    });

    const runner = createRunner({
      tools: result.tools,
      requestApproval: async () => "approved",
      timeoutMs: 15_000,
    });

    // Fetch 3 posts, then fetch the user for each one
    const runResult = await runner.run(`
      const posts = await tools.placeholder.posts.listPosts({ _limit: 3 });
      const results = [];
      for (const post of posts) {
        const user = await tools.placeholder.users.getUser({ id: post.userId });
        results.push({ postTitle: post.title, authorName: user.name });
      }
      return results;
    `);

    expect(runResult.ok).toBe(true);

    const value = runResult.value as Array<{ postTitle: string; authorName: string }>;
    expect(value).toHaveLength(3);
    expect(typeof value[0]!.postTitle).toBe("string");
    expect(typeof value[0]!.authorName).toBe("string");

    // 1 listPosts + 3 getUser = 4 receipts
    expect(runResult.receipts).toHaveLength(4);
  }, { timeout: 15_000 });
});
