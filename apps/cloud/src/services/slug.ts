// ---------------------------------------------------------------------------
// Organization slug generation
// ---------------------------------------------------------------------------
//
// Slugs are derived from the organization's display name and disambiguated
// with a short, deterministic suffix sourced from the WorkOS organization
// ID. This means two orgs with identical names still get different slugs,
// and the slug stays stable across renames (suffix is tied to id, not name).
//
// The slug shape is `<slugified-name>-<suffix>`. Suffix is the first 6
// alphanumeric characters of the id after the `org_` prefix, lowercased.
// Example: id="org_01HABC...XYZ", name="Acme Inc" → slug="acme-inc-01habc".

const slugifyName = (name: string): string => {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized === "" ? "org" : normalized;
};

const idSuffix = (id: string): string => {
  const stripped = id.replace(/^org_/, "").toLowerCase();
  const alnum = stripped.replace(/[^a-z0-9]/g, "");
  const candidate = alnum.slice(0, 6);
  return candidate === "" ? "x" : candidate;
};

export const makeOrganizationSlug = (args: { id: string; name: string }): string =>
  `${slugifyName(args.name)}-${idSuffix(args.id)}`;
