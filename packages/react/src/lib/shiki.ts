import { createHighlighterCore, type HighlighterCore, type LanguageInput } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { useIsDark } from "../hooks/use-is-dark";

// ---------------------------------------------------------------------------
// Supported languages — explicit imports to avoid bundling all grammars
// ---------------------------------------------------------------------------

const SUPPORTED_LANGS = [
  "json",
  "xml",
  "yaml",
  "shellscript",
  "typescript",
  "javascript",
  "python",
  "html",
  "css",
  "markdown",
  "sql",
  "graphql",
  "go",
  "rust",
  "java",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "c",
  "cpp",
  "csharp",
  "tsx",
  "jsx",
  "toml",
  "dockerfile",
  "diff",
  "http",
  "jsonc",
  "log",
  "proto",
] as const;

type SupportedLang = (typeof SUPPORTED_LANGS)[number];

const LANG_ALIASES: Record<string, SupportedLang> = {
  sh: "shellscript",
  shell: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  kt: "kotlin",
  md: "markdown",
  gql: "graphql",
  yml: "yaml",
};

const LANG_LOADERS: Record<SupportedLang, () => LanguageInput> = {
  json: () => import("@shikijs/langs/json"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  python: () => import("@shikijs/langs/python"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  markdown: () => import("@shikijs/langs/markdown"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  java: () => import("@shikijs/langs/java"),
  ruby: () => import("@shikijs/langs/ruby"),
  php: () => import("@shikijs/langs/php"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  toml: () => import("@shikijs/langs/toml"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  diff: () => import("@shikijs/langs/diff"),
  http: () => import("@shikijs/langs/http"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  log: () => import("@shikijs/langs/log"),
  proto: () => import("@shikijs/langs/proto"),
};

const supportedSet = new Set<string>([...SUPPORTED_LANGS, ...Object.keys(LANG_ALIASES)]);

export const SUPPORTED_THEMES = ["github-dark", "github-light"] as const;
export type SupportedTheme = (typeof SUPPORTED_THEMES)[number];

export const DEFAULT_LIGHT_THEME: SupportedTheme = "github-light";
export const DEFAULT_DARK_THEME: SupportedTheme = "github-dark";

export type ShikiThemeProp =
  | SupportedTheme
  | { light: SupportedTheme; dark: SupportedTheme };

/**
 * Resolve a `ShikiThemeProp` (either a single theme or a `{ light, dark }`
 * pair) to the theme that should currently be used, reacting to system
 * dark-mode changes. When no theme is provided, the default github pair is
 * used.
 */
export function useResolvedShikiTheme(theme?: ShikiThemeProp): SupportedTheme {
  const isDark = useIsDark();
  if (typeof theme === "string") return theme;
  const light = theme?.light ?? DEFAULT_LIGHT_THEME;
  const dark = theme?.dark ?? DEFAULT_DARK_THEME;
  return isDark ? dark : light;
}

export function resolveLang(lang: string): SupportedLang | null {
  const l = lang.trim().toLowerCase();
  if (l in LANG_LOADERS) return l as SupportedLang;
  if (l in LANG_ALIASES) return LANG_ALIASES[l]!;
  return null;
}

export function isSupportedLang(lang: string): boolean {
  return supportedSet.has(lang.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Shared singleton highlighter — lazy, created on first use
// ---------------------------------------------------------------------------

const jsEngine = createJavaScriptRegexEngine({ forgiving: true });

let _promise: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
  if (!_promise) {
    _promise = createHighlighterCore({
      themes: [
        import("@shikijs/themes/github-dark"),
        import("@shikijs/themes/github-light"),
      ],
      langs: Object.values(LANG_LOADERS).map((loader) => loader()),
      engine: jsEngine,
    });
  }
  return _promise;
}

// ---------------------------------------------------------------------------
// Streamdown code highlighter plugin
// ---------------------------------------------------------------------------

import type { CodeHighlighterPlugin, ThemeInput } from "streamdown";

const tokensCache = new Map<string, unknown>();
const pendingCallbacks = new Map<string, Set<(result: unknown) => void>>();

/**
 * Read the current system color-scheme preference synchronously. Used in
 * non-React contexts (like the streamdown plugin) where hooks aren't
 * available.
 */
const prefersDarkNow = (): boolean => {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

export function createCodeHighlighterPlugin(): CodeHighlighterPlugin {
  return {
    name: "shiki" as const,
    type: "code-highlighter" as const,
    getSupportedLanguages: () => [...SUPPORTED_LANGS] as string[] as never,
    getThemes: () => [
      DEFAULT_LIGHT_THEME as ThemeInput,
      DEFAULT_DARK_THEME as ThemeInput,
    ],
    supportsLanguage: (language: string) => isSupportedLang(language),
    highlight(options, callback) {
      const resolved = resolveLang(options.language);
      const lang = resolved ?? "json";
      const activeTheme = prefersDarkNow() ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
      const key = `${activeTheme}:${lang}:${options.code.length}:${options.code.slice(0, 128)}`;

      const cached = tokensCache.get(key);
      if (cached) return cached as never;

      if (callback) {
        if (!pendingCallbacks.has(key)) {
          pendingCallbacks.set(key, new Set());
        }
        pendingCallbacks.get(key)!.add(callback as (result: unknown) => void);
      }

      void getHighlighter().then((highlighter) => {
        if (tokensCache.has(key)) {
          const result = tokensCache.get(key);
          pendingCallbacks.get(key)?.forEach((cb) => cb(result));
          pendingCallbacks.delete(key);
          return;
        }
        const result = highlighter.codeToTokens(options.code, {
          lang,
          themes: { light: activeTheme, dark: activeTheme },
        });
        tokensCache.set(key, result);
        pendingCallbacks.get(key)?.forEach((cb) => cb(result));
        pendingCallbacks.delete(key);
      });

      return null;
    },
  };
}
