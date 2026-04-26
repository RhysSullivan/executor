// ---------------------------------------------------------------------------
// Serialize Effect's in-process `Metric.unsafeSnapshot()` into Prometheus
// text exposition format (spec:
// https://prometheus.io/docs/instrumenting/exposition_formats/).
//
// Powers `GET /api/metrics`. No external deps; the format is small enough
// to hand-roll, and keeping this in-house avoids pulling in a Prometheus
// client library for a feature that's secondary to the OTLP push path.
// ---------------------------------------------------------------------------

import * as Metric from "effect/Metric";
import type * as MetricKey from "effect/MetricKey";
import * as MetricState from "effect/MetricState";
import * as Option from "effect/Option";

/**
 * Prometheus forbids `.` / `-` / other punctuation in metric names.
 * Converts `executor.execution.duration_ms` → `executor_execution_duration_ms`.
 */
const sanitizeName = (raw: string): string =>
  raw.replace(/[^a-zA-Z0-9_:]/g, "_");

/**
 * Prometheus label value escaping: backslash, double-quote, newline.
 */
const escapeLabelValue = (raw: string): string =>
  raw.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

const formatLabels = (
  tags: ReadonlyArray<{ readonly key: string; readonly value: string }>,
  extra?: Record<string, string>,
): string => {
  const pairs: string[] = [];
  for (const tag of tags) {
    pairs.push(`${sanitizeName(tag.key)}="${escapeLabelValue(tag.value)}"`);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      pairs.push(`${sanitizeName(k)}="${escapeLabelValue(v)}"`);
    }
  }
  return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
};

/**
 * Format a number in Prometheus-friendly form. `Infinity` becomes `+Inf` /
 * `-Inf`; `NaN` stays as `NaN`. Bigints flattened to numbers.
 */
const formatValue = (value: number | bigint): string => {
  if (typeof value === "bigint") return value.toString(10);
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
};

type PrometheusLine = string;

/**
 * Emit the `# HELP` + `# TYPE` header block for a given metric family,
 * deduplicated by name (every data point of the same family shares one
 * header, per Prometheus spec).
 */
const emitHeader = (
  name: string,
  type: "counter" | "gauge" | "histogram" | "summary",
  description: string,
  seen: Set<string>,
): PrometheusLine[] => {
  if (seen.has(name)) return [];
  seen.add(name);
  const safeDescription = description
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n");
  return [
    `# HELP ${name} ${safeDescription || "(no description)"}`,
    `# TYPE ${name} ${type}`,
  ];
};

/**
 * Serialize a single `MetricPair` (key + state) to zero or more
 * Prometheus exposition lines. Behavior by state type:
 *
 * - `Counter` → single `<name>{tags} <value>` line.
 * - `Gauge` → single line, TYPE=gauge.
 * - `Histogram` → one `<name>_bucket{le="X"}` line per bucket (cumulative,
 *   Prometheus-style), plus `<name>_bucket{le="+Inf"}`, `<name>_count`,
 *   `<name>_sum`.
 * - `Frequency` → one counter row per occurrence key, with a synthetic
 *   `bucket` tag carrying the key.
 * - `Summary` → `<name>{quantile="X"}` for each quantile, plus
 *   `<name>_count` and `<name>_sum`.
 */
type SnapshotPair = {
  readonly metricKey: MetricKey.MetricKey.Untyped;
  readonly metricState: MetricState.MetricState.Untyped;
};

const formatPair = (pair: SnapshotPair, seen: Set<string>): PrometheusLine[] => {
  const rawName = pair.metricKey.name;
  const name = sanitizeName(rawName);
  const description = Option.getOrElse(pair.metricKey.description, () => "");
  const tags = pair.metricKey.tags;
  const state = pair.metricState;
  const lines: PrometheusLine[] = [];

  if (MetricState.isCounterState(state)) {
    lines.push(...emitHeader(name, "counter", description, seen));
    lines.push(`${name}${formatLabels(tags)} ${formatValue(state.count)}`);
    return lines;
  }

  if (MetricState.isGaugeState(state)) {
    lines.push(...emitHeader(name, "gauge", description, seen));
    lines.push(`${name}${formatLabels(tags)} ${formatValue(state.value)}`);
    return lines;
  }

  if (MetricState.isHistogramState(state)) {
    lines.push(...emitHeader(name, "histogram", description, seen));
    // Effect's buckets are `[upperBound, cumulativeCount]`. Prometheus
    // expects cumulative counts already; emit as-is.
    for (const [upperBound, count] of state.buckets) {
      lines.push(
        `${name}_bucket${formatLabels(tags, { le: formatValue(upperBound) })} ${count}`,
      );
    }
    // +Inf bucket required by the spec; equal to total count.
    lines.push(
      `${name}_bucket${formatLabels(tags, { le: "+Inf" })} ${state.count}`,
    );
    lines.push(`${name}_count${formatLabels(tags)} ${state.count}`);
    lines.push(`${name}_sum${formatLabels(tags)} ${formatValue(state.sum)}`);
    return lines;
  }

  if (MetricState.isSummaryState(state)) {
    lines.push(...emitHeader(name, "summary", description, seen));
    for (const [quantile, value] of state.quantiles) {
      const numeric = Option.getOrElse(value, () => Number.NaN);
      lines.push(
        `${name}${formatLabels(tags, { quantile: formatValue(quantile) })} ${formatValue(numeric)}`,
      );
    }
    lines.push(`${name}_count${formatLabels(tags)} ${state.count}`);
    lines.push(`${name}_sum${formatLabels(tags)} ${formatValue(state.sum)}`);
    return lines;
  }

  if (MetricState.isFrequencyState(state)) {
    // Frequency isn't a first-class Prometheus type — represent it as a
    // counter family with a synthetic `bucket` label so each occurrence
    // becomes a distinct time series.
    lines.push(...emitHeader(name, "counter", description, seen));
    for (const [bucket, count] of state.occurrences) {
      lines.push(
        `${name}${formatLabels(tags, { bucket })} ${count}`,
      );
    }
    return lines;
  }

  // Unknown metric type — skip silently. Shouldn't happen with current
  // Effect versions but future additions (e.g. exponential histograms)
  // would land here.
  return lines;
};

/**
 * Render the current Effect metric snapshot as Prometheus exposition text.
 * The snapshot is read via `Metric.unsafeSnapshot()` — synchronous, lives
 * in the process-wide registry.
 */
export const renderPrometheus = (): string => {
  const pairs = Metric.unsafeSnapshot();
  const seen = new Set<string>();
  const lines: PrometheusLine[] = [];

  for (const pair of pairs) {
    lines.push(...formatPair(pair, seen));
  }

  // Prometheus requires a trailing newline; most scrapers are tolerant
  // but the spec is specific about it.
  return lines.length === 0 ? "\n" : lines.join("\n") + "\n";
};
