import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";

import { InternalError } from "../observability";

// ---------------------------------------------------------------------------
// Prometheus text exposition on `GET /api/metrics`.
//
// Returns the current in-process `Effect.Metric` snapshot in the spec
// format: https://prometheus.io/docs/instrumenting/exposition_formats/.
//
// Mount notes for hosts:
// - Self-hosted local daemon: mount unconditionally (operator can scrape).
// - Cloud: mount under the protected API so each org only sees their own
//   metrics. The core API group doesn't carry auth middleware itself;
//   the host app composes that above.
// ---------------------------------------------------------------------------

const PrometheusResponse = HttpApiSchema.Text({ contentType: "text/plain" });

export class MetricsApi extends HttpApiGroup.make("metrics")
  .add(HttpApiEndpoint.get("scrape")`/metrics`.addSuccess(PrometheusResponse))
  .addError(InternalError) {}
