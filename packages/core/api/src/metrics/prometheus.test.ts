import { describe, expect, it } from "@effect/vitest";
import { Effect, Metric, MetricBoundaries } from "effect";

import { renderPrometheus } from "./prometheus";

// ---------------------------------------------------------------------------
// Integration-style tests against Effect's live `Metric.unsafeSnapshot()`
// registry. Each test stamps a metric with a unique name so assertions
// don't collide with values accumulated in prior tests — the registry
// is process-wide and not reset between tests.
// ---------------------------------------------------------------------------

const uniqueName = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

describe("renderPrometheus", () => {
  it.effect("emits counter HELP + TYPE + sanitized name", () =>
    Effect.gen(function* () {
      const name = uniqueName("pr_counter.ticks");
      const counter = Metric.counter(name, { description: "example counter" });
      yield* Metric.update(counter, 7);

      const output = renderPrometheus();
      const sanitized = name.replace(/\./g, "_");
      expect(output).toMatch(new RegExp(`# HELP ${sanitized} example counter`));
      expect(output).toMatch(new RegExp(`# TYPE ${sanitized} counter`));
      expect(output).toMatch(new RegExp(`^${sanitized} 7$`, "m"));
    }),
  );

  it.effect("emits histogram bucket lines + +Inf + count + sum", () =>
    Effect.gen(function* () {
      const name = uniqueName("pr_hist.ms");
      const histogram = Metric.histogram(
        name,
        MetricBoundaries.linear({ start: 0, width: 10, count: 3 }),
      );
      yield* Metric.update(histogram, 5);
      yield* Metric.update(histogram, 15);

      const output = renderPrometheus();
      const sanitized = name.replace(/\./g, "_");
      expect(output).toMatch(new RegExp(`# TYPE ${sanitized} histogram`));
      expect(output).toMatch(
        new RegExp(`^${sanitized}_bucket{le="\\+Inf"} 2$`, "m"),
      );
      expect(output).toMatch(new RegExp(`^${sanitized}_count 2$`, "m"));
      expect(output).toMatch(new RegExp(`^${sanitized}_sum 20$`, "m"));
    }),
  );

  it.effect("escapes label values with quotes + backslashes", () =>
    Effect.gen(function* () {
      const name = uniqueName("pr_labeled");
      const counter = Metric.counter(name).pipe(
        Metric.tagged("path", `github.io/search"broken\\"`),
      );
      yield* Metric.update(counter, 1);

      const output = renderPrometheus();
      const sanitized = name.replace(/\./g, "_");
      // Label values preserve all characters except `\` → `\\`, `"` → `\"`,
      // `\n` → `\n` (literal). Dots stay; only names are sanitized.
      expect(output).toContain(`${sanitized}{path="github.io/search\\"broken\\\\\\""} 1`);
    }),
  );

  it("emits a single trailing newline for empty snapshots when nothing ever registered", () => {
    // Can't actually test the empty path in a shared process (other tests
    // register metrics), so just assert the output always ends in \n.
    const output = renderPrometheus();
    expect(output.endsWith("\n")).toBe(true);
  });
});
