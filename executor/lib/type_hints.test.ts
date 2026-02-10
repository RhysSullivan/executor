import { expect, test } from "bun:test";
import {
  compactArgTypeHint,
  compactDescriptionLine,
  compactReturnTypeHint,
  extractTopLevelTypeKeys,
} from "./type_hints";

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

test("compactReturnTypeHint collapses graphql envelopes", async () => {
  const compact = compactReturnTypeHint("{ data: { issue: { id: string; title: string } }; errors: unknown[] }");
  expect(compact).toBe("{ data: ...; errors: unknown[] }");
});

test("compactDescriptionLine trims to a single concise line", async () => {
  const compact = compactDescriptionLine("Create a database in Notion.\nThis endpoint supports parent/page context.");
  expect(compact).toBe("Create a database in Notion.");
});
