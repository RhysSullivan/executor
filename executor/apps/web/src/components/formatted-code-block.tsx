"use client";

import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { cn } from "@/lib/utils";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

type CodeTone = "default" | "green" | "amber" | "red";

function toCodeFence(content: string, language: string) {
  return `~~~~${language}\n${content}\n~~~~`;
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
