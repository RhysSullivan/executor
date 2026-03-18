import * as Effect from "effect/Effect";

import {
  fallbackSourceDiscoveryResult,
  normalizeSourceDiscoveryUrl,
  probeHeadersFromAuth,
  type SourceAdapter,
  type SourceProbeAuth,
  type SourceDiscoveryResult,
} from "@executor/source-core";

import { builtInSourceAdapters } from "./source-adapters";

type DiscoverableSourceAdapter = SourceAdapter & {
  detectSource: NonNullable<SourceAdapter["detectSource"]>;
};

const sourceAdapters: ReadonlyArray<SourceAdapter> = builtInSourceAdapters;

const discoverableSourceAdapters = sourceAdapters.filter(
  (adapter): adapter is DiscoverableSourceAdapter =>
    adapter.detectSource !== undefined,
);

export const discoverSource = (input: {
  url: string;
  probeAuth?: SourceProbeAuth | null;
}): Effect.Effect<SourceDiscoveryResult, Error, never> =>
  Effect.gen(function* () {
    const normalizedUrl = yield* Effect.try({
      try: () => normalizeSourceDiscoveryUrl(input.url),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });
    const headers = probeHeadersFromAuth(input.probeAuth);

    const adaptersByPriority = [...discoverableSourceAdapters].sort(
      (left, right) =>
        (right.discoveryPriority?.({ normalizedUrl }) ?? 0)
        - (left.discoveryPriority?.({ normalizedUrl }) ?? 0),
    );

    for (const adapter of adaptersByPriority) {
      const detected = yield* adapter.detectSource({
        normalizedUrl,
        headers,
      });
      if (detected) {
        return detected;
      }
    }

    return fallbackSourceDiscoveryResult(normalizedUrl);
  });
