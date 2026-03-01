import { WorkOS } from "@workos-inc/node";

export interface LatencyStats {
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
}

export function getArg(name: string): string | undefined {
  const prefixed = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefixed)) {
      return arg.slice(prefixed.length);
    }
  }

  const exact = `--${name}`;
  const index = process.argv.indexOf(exact);
  if (index === -1) {
    return undefined;
  }

  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) {
    return undefined;
  }

  return next;
}

export function hasFlag(name: string): boolean {
  const exact = `--${name}`;
  return process.argv.includes(exact);
}

export function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readRequiredEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function readInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

export function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function resolveContext(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return { workspace_id: "local" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse context JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WORKOS_VAULT_CONTEXT_JSON must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

export function resolveWorkosClient(): WorkOS {
  const apiKey = readRequiredEnv("WORKOS_API_KEY");
  return new WorkOS(apiKey);
}

export async function measureLatency<T>(operation: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const startedAt = performance.now();
  const value = await operation();
  const durationMs = performance.now() - startedAt;
  return { value, durationMs };
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const normalized = Math.min(1, Math.max(0, quantile));
  const index = Math.ceil(sortedValues.length * normalized) - 1;
  const clampedIndex = Math.min(sortedValues.length - 1, Math.max(0, index));
  return sortedValues[clampedIndex] ?? 0;
}

export function computeStats(samples: readonly number[]): LatencyStats {
  if (samples.length === 0) {
    return {
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      avgMs: 0,
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);

  return {
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    avgMs: sum / sorted.length,
  };
}

export function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

export function buildObjectName(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

export function buildRandomValue(byteLength: number): string {
  const target = Math.max(16, byteLength);
  const suffix = crypto.randomUUID();
  const head = `bench-${Date.now()}-${suffix}-`;
  const fillerLength = Math.max(0, target - head.length);
  return `${head}${"x".repeat(fillerLength)}`;
}

export function printStats(label: string, samples: readonly number[]): void {
  const stats = computeStats(samples);
  console.log(
    `${label}: min=${formatMs(stats.minMs)} p50=${formatMs(stats.p50Ms)} p95=${formatMs(stats.p95Ms)} max=${formatMs(stats.maxMs)} avg=${formatMs(stats.avgMs)}`,
  );
}
