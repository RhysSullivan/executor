import type { CodeModeRunResult } from "@openassistant/core";

export function formatDiscordResponse(params: {
  prompt: string;
  generatedCode: string;
  rationale: string;
  provider: "claude" | "heuristic";
  result: CodeModeRunResult;
}): string {
  const { prompt, generatedCode, rationale, provider, result } = params;
  const sections = [
    `Prompt: ${prompt}`,
    `Planner (${provider}): ${rationale}`,
    "Code:",
    fenced("ts", generatedCode),
    result.ok ? `Result: ${safeJson(result.value)}` : `Error: ${result.error}`,
    "Receipts:",
    formatReceipts(result.receipts),
  ];

  return truncateDiscord(sections.join("\n\n"));
}

function formatReceipts(receipts: CodeModeRunResult["receipts"]): string {
  if (receipts.length === 0) {
    return "- none";
  }
  return receipts
    .map((receipt) => {
      const parts = [
        `- \`${receipt.toolPath}\``,
        `decision=${receipt.decision}`,
        `status=${receipt.status}`,
      ];
      if (receipt.inputPreview) {
        parts.push(`input="${receipt.inputPreview}"`);
      }
      return parts.join(" ");
    })
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function fenced(lang: string, content: string): string {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

function truncateDiscord(value: string): string {
  const limit = 1_900;
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...`;
}
