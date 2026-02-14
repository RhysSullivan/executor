import type { ToolDescriptor } from "@/lib/types";
import type { ToolGroup } from "@/lib/tool/explorer-grouping";

export function findToolsInGroupByKey(
  groups: ToolGroup[],
  key: string,
): ToolDescriptor[] {
  for (const group of groups) {
    if (group.key === key) {
      return collectToolsFromGroup(group);
    }

    const childGroups = group.children.filter(
      (child): child is ToolGroup => "key" in child,
    );
    if (childGroups.length > 0) {
      const found = findToolsInGroupByKey(childGroups, key);
      if (found.length > 0) {
        return found;
      }
    }
  }

  return [];
}

function collectToolsFromGroup(group: ToolGroup): ToolDescriptor[] {
  if (group.children.length === 0) {
    return [];
  }

  const childGroups = group.children.filter((child): child is ToolGroup => "key" in child);
  if (childGroups.length > 0) {
    return childGroups.flatMap(collectToolsFromGroup);
  }

  return group.children as ToolDescriptor[];
}
