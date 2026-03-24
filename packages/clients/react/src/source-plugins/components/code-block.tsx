import { useCallback, useEffect, useRef, useState } from "react";

import { codeToHtml, resolveLang } from "../lib/shiki";
import { cn } from "../lib/cn";
import { IconCheck, IconCopy } from "./icons";

const highlightCache = new Map<string, string>();

function cacheKey(code: string, lang: string) {
  return `${lang}::${code.length}::${code.slice(0, 64)}`;
}

function detectLanguage(code: string, hint?: string): string {
  if (hint) {
    return resolveLang(hint) ?? "json";
  }

  const trimmed = code.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  if (trimmed.startsWith("<")) {
    return "xml";
  }
  if (trimmed.startsWith("---")) {
    return "yaml";
  }
  return "json";
}

export function CodeBlock(props: {
  code: string;
  lang?: string;
  className?: string;
}) {
  const { code, lang: langHint, className } = props;
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);

  const language = detectLanguage(code, langHint);
  const key = cacheKey(code, language);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const cached = highlightCache.get(key);
    if (cached) {
      setHtml(cached);
      return;
    }

    let cancelled = false;
    void codeToHtml(code, { lang: language }).then((result) => {
      if (cancelled) {
        return;
      }
      highlightCache.set(key, result);
      if (mountedRef.current) {
        setHtml(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code, key, language]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <div className={cn("group relative overflow-auto", className)}>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/90 p-1.5 text-muted-foreground/40 opacity-0 backdrop-blur-sm transition-all hover:text-foreground group-hover:opacity-100"
        title="Copy to clipboard"
      >
        {copied ? <IconCheck className="size-3" /> : <IconCopy className="size-3" />}
      </button>

      {html ? (
        <div
          className="shiki-container text-[12px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:p-3 [&_code]:font-mono"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="p-3 font-mono text-[12px] leading-relaxed text-foreground/60">
          {code}
        </pre>
      )}
    </div>
  );
}
