import { expect, test } from "bun:test";
import {
  compactArgKeysHint,
  compactArgTypeHint,
  compactDescriptionLine,
  compactReturnTypeHint,
  extractTopLevelTypeKeys,
} from "./type-hints";

test("extractTopLevelTypeKeys handles nested object literals", async () => {
  const keys = extractTopLevelTypeKeys("{ parent: { title: string }; icon?: { emoji: string }; children: string[] }");
  expect(keys).toEqual(["parent", "icon", "children"]);
});

test("compactArgTypeHint keeps only top-level previews", async () => {
  const compact = compactArgTypeHint(
    "{ parent: { database_id: string }; title: Array<{ text: { content: string } }>; icon?: { emoji: string }; properties?: Record<string, unknown> }",
  );
  expect(compact).toBe("{ parent: ...; title: ...; icon: ...; properties: ... }");
});

test("compactArgTypeHint flattens simple object intersections", async () => {
  const compact = compactArgTypeHint(
    "{ owner: string; repo: string; runner_id: number } & { labels: string[] }",
  );
  expect(compact).toBe("{ owner: string; repo: string; runner_id: number; labels: string[] }");
});

test("compactArgTypeHint dedupes trivial unions while preserving concrete types", async () => {
  const compact = compactArgTypeHint("{ app_id: string | string; account_id: string }");
  expect(compact).toBe("{ app_id: string; account_id: string }");
});

test("compactArgKeysHint caps key list with ellipsis", async () => {
  const compact = compactArgKeysHint(["a", "b", "c", "d", "e", "f", "g", "h"]);
  expect(compact).toBe("{ a: ...; b: ...; c: ...; d: ...; e: ...; f: ...; ... }");
});

test("compactReturnTypeHint collapses graphql envelopes", async () => {
  const compact = compactReturnTypeHint("{ data: { issue: { id: string; title: string } }; errors: unknown[] }");
  expect(compact).toBe("{ data: ...; errors: unknown[] }");
});

test("compactReturnTypeHint flattens simple object intersections", async () => {
  const compact = compactReturnTypeHint(
    "{ errors: { code: number }[]; messages: { code: number }[]; success: true } & { result?: { id?: string } }",
  );
  expect(compact).toBe(
    "{ errors: { code: number }[]; messages: { code: number }[]; success: true; result?: { id?: string } }",
  );
});

test("compactDescriptionLine trims to a single concise line", async () => {
  const compact = compactDescriptionLine("Create a database in Notion.\nThis endpoint supports parent/page context.");
  expect(compact).toBe("Create a database in Notion.");
});
