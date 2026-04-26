import type { ExecutionStatus } from "../../api/executions";

export const STATUS_ORDER = [
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
  "cancelled",
  "pending",
] as const satisfies readonly ExecutionStatus[];

export const STATUS_LABELS: Record<ExecutionStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting_for_interaction: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export type StatusTone = {
  /** Tailwind bg-* class for the solid dot. */
  readonly dot: string;
  /** Tailwind text-* class for the inline status label. */
  readonly text: string;
  /** CSS value suitable for recharts bar `fill`. */
  readonly chartFill: string;
  /** Whether to apply `animate-pulse` to the dot. */
  readonly pulse: boolean;
};

export const STATUS_TONES: Record<ExecutionStatus, StatusTone> = {
  completed: {
    dot: "bg-primary",
    text: "text-primary",
    chartFill: "var(--primary)",
    pulse: false,
  },
  failed: {
    dot: "bg-destructive",
    text: "text-destructive",
    chartFill: "var(--destructive)",
    pulse: false,
  },
  running: {
    dot: "bg-blue-400",
    text: "text-blue-400",
    chartFill: "#60a5fa",
    pulse: true,
  },
  waiting_for_interaction: {
    dot: "bg-amber-400",
    text: "text-amber-400",
    chartFill: "#fbbf24",
    pulse: true,
  },
  cancelled: {
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
    chartFill: "var(--muted-foreground)",
    pulse: false,
  },
  pending: {
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    chartFill: "color-mix(in srgb, var(--muted-foreground) 50%, transparent)",
    pulse: false,
  },
};

export const statusTone = (status: ExecutionStatus): StatusTone => STATUS_TONES[status];

export type TriggerTone = {
  readonly dot: string;
  readonly text: string;
  readonly label: string;
};

const UNKNOWN_TRIGGER_TONE: TriggerTone = {
  dot: "bg-muted-foreground/40",
  text: "text-muted-foreground",
  label: "unknown",
};

export const TRIGGER_TONES: Record<string, TriggerTone> = {
  mcp: {
    dot: "bg-[color:var(--color-info)]",
    text: "text-[color:var(--color-info)]",
    label: "mcp",
  },
  http: {
    dot: "bg-[color:var(--color-success)]",
    text: "text-[color:var(--color-success)]",
    label: "http",
  },
  cli: {
    dot: "bg-foreground/70",
    text: "text-foreground",
    label: "cli",
  },
};

export const triggerTone = (kind: string | null | undefined): TriggerTone => {
  if (!kind) return UNKNOWN_TRIGGER_TONE;
  return TRIGGER_TONES[kind] ?? { ...UNKNOWN_TRIGGER_TONE, label: kind };
};

export const TRIGGER_ORDER = ["mcp", "http", "cli"] as const;
