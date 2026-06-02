import { Cause, Logger, References } from "effect";

// ---------------------------------------------------------------------------
// Structured logging for executor's client runtimes (cli / local / desktop).
//
// These apps do NOT phone home: this installs a structured, service-annotated
// logger only. There is no OTLP exporter and no external endpoint — nothing
// leaves the machine. `Effect.fn("Domain.method")` span names still produce
// named fibers and log/span context here, but spans stay in-process.
//
// Cloud is the only surface that exports telemetry, and it keeps its own
// (Axiom) setup — this module is intentionally not wired there.
// ---------------------------------------------------------------------------

type Fields = Record<string, unknown>;

const LEVEL: Record<string, string> = {
  Trace: "debug",
  Debug: "debug",
  Warn: "warn",
  Error: "error",
  Fatal: "error",
};

const level = (label: string): string => LEVEL[label] ?? "info";

const render = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  // Non-throwing stringify: handle bigint + circular refs inline so domain
  // code never needs a try/catch boundary.
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, candidate) => {
      if (typeof candidate === "bigint") return candidate.toString();
      if (typeof candidate === "object" && candidate !== null) {
        if (seen.has(candidate)) return "[Circular]";
        seen.add(candidate);
      }
      return candidate;
    }) ?? String(value)
  );
};

const message = (input: unknown): string => {
  if (Array.isArray(input)) return input.map(render).join(" ");
  return render(input);
};

// A single yieldable logger: structured key=value annotations, log-span
// durations, and a pretty-printed cause on failures. Writes to stderr so CLI
// stdout stays reserved for machine-readable output.
export const logger = Logger.make((options) => {
  const fields: Fields = {};
  for (const [key, value] of Object.entries(
    options.fiber.getRef(References.CurrentLogAnnotations),
  )) {
    if (value !== undefined && value !== null) fields[key] = value;
  }
  const now = options.date.getTime();
  for (const [key, start] of options.fiber.getRef(References.CurrentLogSpans)) {
    fields[`${key}.ms`] = now - start;
  }

  // `service` is promoted into the line prefix rather than rendered as a field.
  const service = typeof fields.service === "string" ? fields.service : undefined;
  delete fields.service;

  const prefix = service ? `${level(options.logLevel)} ${service}:` : `${level(options.logLevel)}:`;
  const annotations = Object.entries(fields)
    .map(([key, value]) => `${key}=${render(value)}`)
    .join(" ");
  const cause = options.cause.reasons.length > 0 ? `\n${Cause.pretty(options.cause)}` : "";

  const line = [prefix, message(options.message), annotations]
    .filter((part) => part.length > 0)
    .join(" ");
  process.stderr.write(`${line}${cause}\n`);
});

// Replaces the default logger in the runtimes it is merged into.
export const layer = Logger.layer([logger], { mergeWithExisting: false });

export * as Observability from "./observability";
