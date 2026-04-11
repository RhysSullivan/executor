import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import {
  getHighlighter,
  resolveLang,
  useResolvedShikiTheme,
  type ShikiThemeProp,
  type SupportedTheme,
} from "../lib/shiki";
import { cn } from "../lib/utils";
import { Button } from "./button";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectLanguage(code: string, hint?: string): string {
  if (hint) return resolveLang(hint) ?? "json";
  const trimmed = code.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith("<")) return "xml";
  if (trimmed.startsWith("---")) return "yaml";
  return "json";
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const CopyIcon = () => (
  <svg viewBox="0 0 16 16" className="size-3">
    <rect
      x="5"
      y="5"
      width="8"
      height="8"
      rx="1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <path d="M3 11V3h8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" className="size-3">
    <path
      d="M3 8l3 3 7-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// ---------------------------------------------------------------------------
// Highlight hook
// ---------------------------------------------------------------------------

function useHighlighted(code: string, lang: string, theme: SupportedTheme): ReactNode | null {
  const [highlighted, setHighlighted] = useState<ReactNode | null>(null);

  useEffect(() => {
    let cancelled = false;

    getHighlighter().then((highlighter) => {
      if (cancelled) return;

      const hast = highlighter.codeToHast(code, { lang, theme });
      const nodes = toJsxRuntime(hast, { jsx, jsxs, Fragment });

      if (!cancelled) setHighlighted(nodes);
    });

    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  return highlighted;
}

// ---------------------------------------------------------------------------
// CodeBlock
// ---------------------------------------------------------------------------

export function CodeBlock(props: {
  code: string;
  lang?: string;
  title?: string;
  maxHeight?: string;
  className?: string;
  theme?: ShikiThemeProp;
}) {
  const { code, lang: langHint, title, className, theme } = props;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const language = useMemo(() => detectLanguage(code, langHint), [code, langHint]);
  const resolvedTheme = useResolvedShikiTheme(theme);
  const highlighted = useHighlighted(code, language, resolvedTheme);

  const lines = code.split("\n");
  const isLong = lines.length > 24;
  const maxH = !expanded && isLong ? (props.maxHeight ?? "24rem") : undefined;

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <div className={cn("rounded-lg border border-border bg-card/60 overflow-hidden", className)}>
      {title && (
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {title}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            className="text-muted-foreground/30 hover:text-muted-foreground"
            title="Copy"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
      )}
      <div className="group relative">
        {!title && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/90 p-1.5 text-muted-foreground/40 opacity-0 backdrop-blur-sm hover:text-foreground group-hover:opacity-100 transition-opacity"
            title="Copy to clipboard"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        )}

        <div
          className="overflow-auto text-[12px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:p-3 [&_code]:font-mono"
          style={maxH ? { maxHeight: maxH } : undefined}
        >
          {highlighted ?? (
            <pre className="p-3 font-mono text-[12px] leading-relaxed text-foreground/60">
              {code}
            </pre>
          )}
        </div>

        {isLong && !expanded && (
          <div className="absolute bottom-0 left-0 right-0 flex justify-center bg-gradient-to-t from-card/90 to-transparent pb-2 pt-8">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExpanded(true)}
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Show all ({lines.length} lines)
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
