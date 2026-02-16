export function normalizePersonalOrganizationName(name: string): string {
  const match = name.match(/^(.*)'s Workspace$/i);
  if (!match) {
    return name;
  }
  const ownerName = match[1]?.trim();
  if (!ownerName) {
    return name;
  }
  return `${ownerName}'s Organization`;
}
