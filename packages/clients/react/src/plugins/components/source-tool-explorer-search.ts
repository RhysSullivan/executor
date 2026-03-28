export type SourceToolExplorerSearch = {
  tab: "model" | "discover";
  tool?: string;
  query?: string;
};

const sourceToolExplorerTabs = ["model", "discover"] as const;

export const parseSourceToolExplorerSearch = (
  search: Record<string, unknown>,
): SourceToolExplorerSearch => ({
  tab:
    typeof search.tab === "string"
    && sourceToolExplorerTabs.includes(
      search.tab as SourceToolExplorerSearch["tab"],
    )
      ? (search.tab as SourceToolExplorerSearch["tab"])
      : "model",
  tool:
    typeof search.tool === "string" && search.tool.length > 0
      ? search.tool
      : undefined,
  query: typeof search.query === "string" ? search.query : undefined,
});
