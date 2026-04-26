import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { renderPrometheus } from "../metrics/prometheus";

// `renderPrometheus` reads the process-wide Effect metric registry via
// `Metric.unsafeSnapshot()`. Synchronous, side-effect-free, no executor
// services required — handler is minimal.
export const MetricsHandlers = HttpApiBuilder.group(ExecutorApi, "metrics", (handlers) =>
  handlers.handle("scrape", () => Effect.sync(() => renderPrometheus())),
);
