import { convertFileListToFileUIParts, tool } from "ai";
import { z } from "zod";

import { createStaticDiscoveryFromTools, toExecutorTool } from "./index";

const listIssues = tool({
  description: "List repository issues",
  inputSchema: z.object({ owner: z.string(), repo: z.string() }),
  execute: async ({ owner, repo }: { owner: string; repo: string }) => ({
    items: [`${owner}/${repo}#1`],
  }),
});

const createIssue = tool({
  description: "Create repository issue",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
  }),
  execute: async ({ owner, repo, title }: { owner: string; repo: string; title: string }) => ({
    id: "issue_123",
    owner,
    repo,
    title,
  }),
});

const wrappedTools = {
  "github.issues.list": listIssues,
  "github.issues.create": toExecutorTool({
    tool: createIssue,
    metadata: {
      interaction: "required",
    },
  }),
};

export const staticDemo = createStaticDiscoveryFromTools({
  tools: wrappedTools,
  sourceKey: "api.github",
});