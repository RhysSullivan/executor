"use client";

import { useMemo } from "react";
import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

function prettyJson(raw: string): string {
  const trimmed = raw.trim();

  // If it looks like JSON, try to parse + re-format
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // fall through
    }
  }

  // Otherwise use the simple TS-like formatter
  if (trimmed.includes("\n") || trimmed.length < 50) {
    return trimmed;
  }

  let output = "";
  let indent = 0;
  const tab = "  ";
  let index = 0;

  while (index < trimmed.length) {
    const char = trimmed[index];

    if (char === "[" && trimmed[index + 1] === "]") {
      output += "[]";
      index += 2;
    } else if (char === "{") {
      indent++;
      output += `${char}\n${tab.repeat(indent)}`;
      index++;
      while (index < trimmed.length && trimmed[index] === " ") {
        index++;
      }
    } else if (char === "}") {
      indent = Math.max(0, indent - 1);
      output = output.replace(/\s+$/, "");
      output += `\n${tab.repeat(indent)}${char}`;
      index++;
    } else if (char === ";" && trimmed[index + 1] === " ") {
      output += `;\n${tab.repeat(indent)}`;
      index += 2;
    } else if (char === "," && indent > 0 && trimmed[index + 1] === " ") {
      output += `,\n${tab.repeat(indent)}`;
      index += 2;
    } else {
      output += char;
      index++;
    }
  }

  return output;
}

export function TypeSignature({ raw, label, lang }: { raw: string; label: string; lang?: string }) {
  const isJson = raw.trim().startsWith("{") || raw.trim().startsWith("[");
  const effectiveLang = lang ?? (isJson ? "json" : "typescript");
  const formatted = useMemo(() => prettyJson(raw), [raw]);

  const { data: highlightedHtml } = useTanstackQuery<string>({
    queryKey: ["type-signature", formatted, effectiveLang],
    queryFn: async () => {
      const { codeToHtml } = await import("shiki");
      return codeToHtml(formatted, {
        lang: effectiveLang,
        themes: { light: "github-light", dark: "github-dark" },
      });
    },
    staleTime: Infinity,
  });

  return (
    <div className="relative group/schema">
      {label ? (
        <div className="flex items-center justify-between mb-1">
          <p className="font-mono text-[9px] font-medium tracking-wider uppercase text-muted-foreground/60">
            {label}
          </p>
          <CopyButton
            text={formatted}
            className="opacity-0 group-hover/schema:opacity-100 transition-opacity"
          />
        </div>
      ) : (
        <CopyButton
          text={formatted}
          className="absolute right-2 top-2 opacity-0 group-hover/schema:opacity-100 transition-opacity z-10"
        />
      )}
      {highlightedHtml ? (
        <div
          className={cn(
            "text-[10.5px] leading-[1.65] bg-muted/40 border border-border/40 rounded-md px-3.5 py-2.5 overflow-x-auto",
            "[&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_code]:!text-[10.5px] [&_code]:!leading-[1.65]",
          )}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="font-mono text-[10.5px] leading-[1.65] bg-muted/40 border border-border/40 rounded-md px-3.5 py-2.5 overflow-x-auto text-foreground/80 whitespace-pre m-0">
          {formatted}
        </pre>
      )}
    </div>
  );
}
