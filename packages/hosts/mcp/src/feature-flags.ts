import { Context, Effect, Layer } from "effect";

export const FEATURE_FLAG_GENERATED_UI_MCP_APPS = "generated-ui-mcp-apps";

export type FeatureFlagContext = {
  readonly distinctId?: string;
  readonly accountId?: string;
  readonly organizationId?: string;
  readonly groups?: Record<string, string>;
};

export type FeatureFlagsShape = {
  readonly isEnabled: (
    flag: string,
    context: FeatureFlagContext,
  ) => Effect.Effect<boolean, unknown, never>;
};

export class FeatureFlags extends Context.Service<FeatureFlags, FeatureFlagsShape>()(
  "@executor-js/host-mcp/FeatureFlags",
) {
  static readonly Disabled: Layer.Layer<FeatureFlags> = Layer.succeed(FeatureFlags, {
    isEnabled: () => Effect.succeed(false),
  });

  static readonly Enabled: Layer.Layer<FeatureFlags> = Layer.succeed(FeatureFlags, {
    isEnabled: () => Effect.succeed(true),
  });
}
