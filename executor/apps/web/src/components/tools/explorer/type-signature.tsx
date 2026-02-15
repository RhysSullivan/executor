"use client";

import { useMemo } from "react";
import { useQuery as useTanstackQuery } from "@tanstack/react-query";

function prettyType(raw: string): string {
  const trimmed = raw.trim();
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

export function TypeSignature({ raw, label }: { raw: string; label: string }) {
  const formatted = useMemo(() => prettyType(raw), [raw]);

  const { data: highlightedHtml } = useTanstackQuery<string>({
    queryKey: ["type-signature", formatted],
    queryFn: async () => {
      const { codeToHtml } = await import("shiki");
      return codeToHtml(formatted, {
        lang: "typescript",
        themes: { light: "github-light", dark: "github-dark" },
      });
    },
    staleTime: Infinity,
  });

  return (
    <div>
      <p className="mb-1 text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50">
        {label}
      </p>
      {highlightedHtml ? (
        <div
          className="type-signature text-[11px] leading-relaxed bg-muted/40 border border-border/40 rounded-md px-2.5 py-2 overflow-x-auto [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_code]:!text-[11px] [&_code]:!leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="text-[11px] font-mono leading-relaxed text-foreground/80 bg-muted/40 border border-border/40 rounded-md px-2.5 py-2 overflow-x-auto whitespace-pre">
          {formatted}
        </pre>
      )}
    </div>
  );
}
