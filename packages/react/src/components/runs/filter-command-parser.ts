export interface RunsFilterTokens {
  readonly status: readonly string[];
  readonly trigger: readonly string[];
  readonly tool: readonly string[];
  readonly code: string | null;
  readonly durationMsMin: number | null;
  readonly durationMsMax: number | null;
  readonly from: number | null;
  readonly to: number | null;
}

export const emptyFilterTokens = (): RunsFilterTokens => ({
  status: [],
  trigger: [],
  tool: [],
  code: null,
  durationMsMin: null,
  durationMsMax: null,
  from: null,
  to: null,
});

const RELATIVE_DURATIONS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

const parseRelativeMs = (literal: string): number | null => {
  const match = /^(\d+)([mhdw])$/.exec(literal);
  if (!match) return null;
  const [, amount, unit] = match;
  const base = RELATIVE_DURATIONS[unit!];
  if (!base) return null;
  return Number(amount) * base;
};

const parseTimestamp = (value: string): number | null => {
  const relative = parseRelativeMs(value);
  if (relative !== null) return Date.now() - relative;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

export const parseFilterCommand = (input: string): RunsFilterTokens => {
  const result: {
    -readonly [K in keyof RunsFilterTokens]: RunsFilterTokens[K] extends readonly (infer E)[]
      ? E[]
      : RunsFilterTokens[K];
  } = {
    status: [],
    trigger: [],
    tool: [],
    code: null,
    durationMsMin: null,
    durationMsMax: null,
    from: null,
    to: null,
  };

  const parts = input.trim().split(/\s+/).filter(Boolean);

  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const key = part.slice(0, colon);
    const value = part.slice(colon + 1);
    if (value.length === 0) continue;

    switch (key) {
      case "status": {
        result.status.push(...value.split(",").filter(Boolean));
        break;
      }
      case "trigger": {
        result.trigger.push(...value.split(",").filter(Boolean));
        break;
      }
      case "tool": {
        result.tool.push(...value.split(",").filter(Boolean));
        break;
      }
      case "code": {
        result.code = value;
        break;
      }
      case "duration_ms": {
        if (value.startsWith(">=")) {
          result.durationMsMin = Number(value.slice(2)) || null;
        } else if (value.startsWith("<=")) {
          result.durationMsMax = Number(value.slice(2)) || null;
        } else if (value.startsWith(">")) {
          result.durationMsMin = (Number(value.slice(1)) || 0) + 1;
        } else if (value.startsWith("<")) {
          result.durationMsMax = (Number(value.slice(1)) || 0) - 1;
        } else {
          const exact = Number(value);
          if (!Number.isNaN(exact)) {
            result.durationMsMin = exact;
            result.durationMsMax = exact;
          }
        }
        break;
      }
      case "after": {
        const ts = parseTimestamp(value);
        if (ts !== null) result.from = ts;
        break;
      }
      case "before": {
        const ts = parseTimestamp(value);
        if (ts !== null) result.to = ts;
        break;
      }
      default:
      // Unknown keys are silently dropped so the input stays forgiving.
    }
  }

  return result;
};

export type FilterCommandKey = {
  readonly key: "status" | "trigger" | "tool" | "code" | "duration_ms" | "after" | "before";
  readonly description: string;
  readonly example: string;
  readonly hints?: readonly string[];
};

export const FILTER_COMMAND_KEYS: readonly FilterCommandKey[] = [
  {
    key: "status",
    description: "Execution status",
    example: "status:failed,completed",
    hints: ["failed", "completed", "running", "waiting"],
  },
  {
    key: "trigger",
    description: "Entry point that started the run",
    example: "trigger:mcp",
    hints: ["mcp", "http", "cli"],
  },
  {
    key: "tool",
    description: "Tool path (supports * glob)",
    example: "tool:github.*",
    hints: ["namespace.*", "exact.path"],
  },
  {
    key: "code",
    description: "Substring of the run's source code",
    example: "code:axiom",
  },
  {
    key: "duration_ms",
    description: "Duration comparator in ms",
    example: "duration_ms:>5000",
    hints: [">5000", "<1000"],
  },
  {
    key: "after",
    description: "Newer than a relative or absolute date",
    example: "after:1h",
    hints: ["15m", "1h", "24h", "7d"],
  },
  {
    key: "before",
    description: "Older than a relative or absolute date",
    example: "before:2026-04-11",
  },
];
