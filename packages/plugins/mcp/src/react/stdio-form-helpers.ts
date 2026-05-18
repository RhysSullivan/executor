// Add and edit must serialize stdio args/env identically — otherwise
// round-tripping a saved source through edit would silently change its
// shape.

const STDIO_ENV_ESCAPE_REPLACEMENTS: Readonly<Record<string, string>> = {
  "\\": "\\",
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
};

const ARG_TOKEN_PATTERN = /[^\s"]+|"([^"]*)"/g;

export const parseStdioArgs = (raw: string): string[] => {
  if (!raw.trim()) return [];
  const args: string[] = [];
  for (const match of raw.matchAll(ARG_TOKEN_PATTERN)) {
    args.push(match[1] ?? match[0]);
  }
  return args;
};

const parseStdioEnvValue = (raw: string): string => {
  const value = raw.trim();
  if (value.length < 2) return value;

  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) {
    return value;
  }

  const inner = value.slice(1, -1);
  if (quote === "'") return inner;

  return inner.replace(
    /\\([\\nrt"])/g,
    (_, escaped: string) => STDIO_ENV_ESCAPE_REPLACEMENTS[escaped] ?? escaped,
  );
};

export const parseStdioEnv = (raw: string): Record<string, string> | undefined => {
  if (!raw.trim()) return undefined;
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      env[line.slice(0, eq).trim()] = parseStdioEnvValue(line.slice(eq + 1));
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
};

// Quote args containing whitespace so the round-trip parse yields the
// same array.
export const formatStdioArgs = (args: readonly string[] | undefined): string => {
  if (!args || args.length === 0) return "";
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
};

// Double-quote values that would otherwise be reshaped by parseStdioEnv
// (leading/trailing whitespace, newlines, embedded quotes/backslashes).
// Plain values pass through unquoted to match what users typed.
export const formatStdioEnv = (env: Record<string, string> | undefined): string => {
  if (!env) return "";
  const needsQuoting = (value: string) => value !== value.trim() || /[\n\r"\\]/.test(value);
  const escape = (value: string) =>
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return Object.entries(env)
    .map(([key, value]) => `${key}=${needsQuoting(value) ? `"${escape(value)}"` : value}`)
    .join("\n");
};
