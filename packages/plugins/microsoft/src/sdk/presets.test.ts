import { describe, expect, it } from "@effect/vitest";

import {
  MICROSOFT_GRAPH_ALL_PRESET_ID,
  MICROSOFT_GRAPH_BASE_SCOPES,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  microsoftGraphExactPathsForPresetIds,
  microsoftGraphPathPrefixesForPresetIds,
  microsoftGraphPresetIdsIncludeAllGraph,
  microsoftGraphScopePresets,
  microsoftGraphScopesForPresetIds,
} from "./presets";

describe("Microsoft Graph scope presets", () => {
  it("keeps default workload ids backed by real presets", () => {
    const ids = new Set(microsoftGraphScopePresets.map((preset) => preset.id));
    expect(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS.every((id) => ids.has(id))).toBe(true);
    expect(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS).toEqual([MICROSOFT_GRAPH_ALL_PRESET_ID]);
  });

  it("marks full Graph selections explicitly", () => {
    expect(microsoftGraphPresetIdsIncludeAllGraph([MICROSOFT_GRAPH_ALL_PRESET_ID])).toBe(true);
    expect(microsoftGraphPresetIdsIncludeAllGraph(["profile", "mail"])).toBe(false);
  });

  it("unions selected preset scopes with base and custom scopes", () => {
    expect(microsoftGraphScopesForPresetIds(["profile", "mail"], ["Sites.Read.All"])).toEqual([
      ...MICROSOFT_GRAPH_BASE_SCOPES,
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "MailboxSettings.ReadWrite",
      "Sites.Read.All",
    ]);
  });

  it("returns path filters for the selected workloads", () => {
    expect(microsoftGraphExactPathsForPresetIds(["profile"])).toContain("/me");
    expect(microsoftGraphPathPrefixesForPresetIds(["mail"])).toContain("/me/messages");
  });

  it("declares product icons for each workload", () => {
    for (const preset of microsoftGraphScopePresets) {
      expect(preset.icon).toMatch(/^https:\/\/svgl\.app\/library\/.+\.svg$/);
    }
  });
});
