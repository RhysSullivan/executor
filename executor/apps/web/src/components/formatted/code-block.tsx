"use client";

import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { cn } from "@/lib/utils";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

type CodeTone = "default" | "green" | "amber" | "red";

function longestRun(content: string, marker: string): number {
  let current = 0;
  let longest = 0;

  for (const char of content) {
    if (char === marker) {
      current += 1;
      if (current > longest) {
        longest = current;
      }
    } else {
      current = 0;
    }
  }

  return longest;
}

function toCodeFence(content: string, language: string) {
  const tickFenceLength = Math.max(4, longestRun(content, "`") + 1);
  const tildeFenceLength = Math.max(4, longestRun(content, "~") + 1);
  const marker = tickFenceLength <= tildeFenceLength ? "`" : "~";
  const length = marker === "`" ? tickFenceLength : tildeFenceLength;
  const fence = marker.repeat(length);

  return `${fence}${language}\n${content}\n${fence}`;
}

function toneClass(tone: CodeTone): string {
  if (tone === "green") return "formatted-code-block--green";
  if (tone === "amber") return "formatted-code-block--amber";
  if (tone === "red") return "formatted-code-block--red";
  return "";
}

export function FormattedCodeBlock({
  content,
  language = "text",
  tone = "default",
  className,
}: {
  content: string;
  language?: string;
  tone?: CodeTone;
  className?: string;
}) {
  const markdown = useMemo(() => toCodeFence(content, language), [content, language]);

  return (
    <div className={cn("formatted-code-block", toneClass(tone), className)}>
      <Streamdown plugins={{ code: codePlugin }} controls={false}>
        {markdown}
      </Streamdown>
    </div>
  );
}
