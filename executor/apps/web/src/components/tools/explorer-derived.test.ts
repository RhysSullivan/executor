import { describe, expect, test } from "bun:test";
import { filterToolsBySearch } from "./explorer-derived";
import type { ToolDescriptor } from "@/lib/types";

describe("filterToolsBySearch", () => {
  const tools: ToolDescriptor[] = [
    {
      path: "linear.issue.create_issue_type",
      description: "Create an issue issue type",
      approval: "auto",
      source: "linear",
    },
    {
      path: "linear.issue.create",
      description: "Create a linear issue",
      approval: "auto",
      source: "linear",
    },
    {
      path: "github.repo.create",
      description: "Create a repository",
      approval: "required",
      source: "github",
    },
  ];

  test("matches separator variants", () => {
    const byUnderscore = filterToolsBySearch(tools, "create_issue");
    const byHyphen = filterToolsBySearch(tools, "create-issue");
    const bySpace = filterToolsBySearch(tools, "create issue");

    expect(byUnderscore.map((tool) => tool.path)).toEqual([
      "linear.issue.create_issue_type",
      "linear.issue.create",
    ]);
    expect(byHyphen.map((tool) => tool.path)).toEqual([
      "linear.issue.create_issue_type",
      "linear.issue.create",
    ]);
    expect(bySpace.map((tool) => tool.path)).toEqual([
      "linear.issue.create_issue_type",
      "linear.issue.create",
    ]);
  });

  test("matches dotted path segments", () => {
    const byDotted = filterToolsBySearch(tools, "issues.create");

    expect(byDotted.map((tool) => tool.path)).toEqual([
      "linear.issue.create_issue_type",
      "linear.issue.create",
    ]);
  });

  test("does not match unrelated search", () => {
    const byRandom = filterToolsBySearch(tools, "archive");

    expect(byRandom).toEqual([]);
  });
});
