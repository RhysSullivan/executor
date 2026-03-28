import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { CodeHighlighterPlugin, ThemeInput } from "streamdown";

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

const supportedSet = new Set<string>([
  ...SUPPORTED_LANGS,
  ...Object.keys(LANG_ALIASES),
]);

export function resolveLang(lang: string): SupportedLang | null {
  const value = lang.trim().toLowerCase();
  if (value in LANG_LOADERS) {
    return value as SupportedLang;
  }
  if (value in LANG_ALIASES) {
    return LANG_ALIASES[value]!;
  }
  return null;
}

export function isSupportedLang(lang: string): boolean {
  return supportedSet.has(lang.trim().toLowerCase());
}

const jsEngine = createJavaScriptRegexEngine({ forgiving: true });

let highlighter: HighlighterCore | null = null;
let highlighterPromise: Promise<HighlighterCore> | null = null;

async function getHighlighter(): Promise<HighlighterCore> {
  if (highlighter) {
    return highlighter;
  }
  if (highlighterPromise) {
    return highlighterPromise;
  }

  highlighterPromise = createHighlighterCore({
    themes: [import("@shikijs/themes/vitesse-dark")],
    langs: Object.values(LANG_LOADERS).map((loader) => loader()),
    engine: jsEngine,
  }).then((instance: HighlighterCore) => {
    highlighter = instance;
    return instance;
  });

  return highlighterPromise;
}

void getHighlighter();

export async function codeToHtml(
  code: string,
  options: { lang: string },
): Promise<string> {
  const highlighter = await getHighlighter();
  const resolved = resolveLang(options.lang) ?? "json";
  return highlighter.codeToHtml(code, {
    lang: resolved,
    theme: "vitesse-dark",
  });
}

const THEME = "vitesse-dark" as ThemeInput;
const tokensCache = new Map<string, unknown>();
const pendingCallbacks = new Map<string, Set<(result: unknown) => void>>();
type CodePluginHighlight = NonNullable<CodeHighlighterPlugin["highlight"]>;
type CodeHighlightOptions = Parameters<CodePluginHighlight>[0];
type CodeHighlightCallback = Parameters<CodePluginHighlight>[1];

export function createLimitedCodePlugin(): CodeHighlighterPlugin {
  return {
    name: "shiki" as const,
    type: "code-highlighter" as const,
    getSupportedLanguages: () => [...SUPPORTED_LANGS] as string[] as never,
    getThemes: () => [THEME, THEME],
    supportsLanguage: (language: string) => isSupportedLang(language),
    highlight(
      options: CodeHighlightOptions,
      callback: CodeHighlightCallback,
    ) {
      const resolved = resolveLang(options.language);
      const lang = resolved ?? "json";
      const key = `${lang}:${options.code.length}:${options.code.slice(0, 128)}`;

      const cached = tokensCache.get(key);
      if (cached) {
        return cached as never;
      }

      if (callback) {
        if (!pendingCallbacks.has(key)) {
          pendingCallbacks.set(key, new Set());
        }
        pendingCallbacks.get(key)!.add(callback as (result: unknown) => void);
      }

      void getHighlighter().then((instance) => {
        if (tokensCache.has(key)) {
          const result = tokensCache.get(key);
          pendingCallbacks.get(key)?.forEach((cb) => cb(result));
          pendingCallbacks.delete(key);
          return;
        }

        const result = instance.codeToTokens(options.code, {
          lang,
          themes: { light: "vitesse-dark", dark: "vitesse-dark" },
        });
        tokensCache.set(key, result);
        pendingCallbacks.get(key)?.forEach((cb) => cb(result));
        pendingCallbacks.delete(key);
      });

      return null;
    },
  };
}
