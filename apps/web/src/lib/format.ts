import { useState, useEffect } from "react";

// Cache formatted results so we don't re-format on every render
const formatCache = new Map<string, string>();

function formatCacheKey(code: string, parser: string): string {
  return `${parser}::${code.length}::${code}`;
}

/**
 * Lazily load prettier + parsers and format code.
 * Returns the original string if formatting fails.
 */
async function formatCode(
  code: string,
  parser: "json" | "typescript" | "babel",
): Promise<string> {
  const key = formatCacheKey(code, parser);
  const cached = formatCache.get(key);
  if (cached) return cached;

  try {
    const [prettier, parserPlugin] = await Promise.all([
      import("prettier/standalone"),
      parser === "json"
        ? import("prettier/plugins/babel")
        : import("prettier/plugins/typescript"),
    ]);

    // both babel and typescript parsers need estree
    const estree = await import("prettier/plugins/estree");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugins: any[] = [parserPlugin, estree];

    let input = code;
    let unwrap = false;

    // Type signature strings (e.g. `{ body: { ... } }`) aren't valid TS
    // on their own. Wrap as `type T = ...` so prettier can parse them.
    if (parser === "typescript") {
      input = `type __T = ${code}`;
      unwrap = true;
    }

    const result = await prettier.format(input, {
      parser: parser === "json" ? "json" : "typescript",
      plugins,
      printWidth: 60,
      tabWidth: 2,
      semi: true,
      singleQuote: false,
      trailingComma: "all",
    });

    let trimmed = result.trimEnd();

    // Strip the `type __T = ` wrapper and trailing `;`
    if (unwrap) {
      trimmed = trimmed
        .replace(/^type __T =\s*/, "")
        .replace(/;$/, "")
        .trimEnd();
    }

    formatCache.set(key, trimmed);
    return trimmed;
  } catch {
    // If formatting fails, return original
    return code;
  }
}

/**
 * Detect the right parser for a code string.
 */
function detectParser(
  code: string,
  langHint?: string,
): "json" | "typescript" | null {
  if (langHint === "json" || langHint === "jsonc") return "json";
  if (langHint === "typescript" || langHint === "ts") return "typescript";

  const trimmed = code.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";

  return null;
}

/**
 * Hook: formats code with prettier. Returns the formatted string
 * (or the original while loading / if formatting fails).
 */
export function useFormattedCode(
  code: string | null,
  langHint?: string,
): string | null {
  const [formatted, setFormatted] = useState<string | null>(code);

  useEffect(() => {
    if (!code) {
      setFormatted(null);
      return;
    }

    const parser = detectParser(code, langHint);
    if (!parser) {
      setFormatted(code);
      return;
    }

    // Check cache synchronously first
    const key = formatCacheKey(code, parser);
    const cached = formatCache.get(key);
    if (cached) {
      setFormatted(cached);
      return;
    }

    // Set original immediately, then replace with formatted
    setFormatted(code);

    let cancelled = false;
    formatCode(code, parser).then((result) => {
      if (!cancelled) setFormatted(result);
    });

    return () => {
      cancelled = true;
    };
  }, [code, langHint]);

  return formatted;
}
