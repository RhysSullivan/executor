import type { Owner } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Owner labels (v2) — Personal vs Workspace.
//
// v1's scope stack (personal → org) collapsed to a single `Owner` axis: a
// connection / policy is owned by the `org` (tenant-shared) or by the acting
// `user`. The global "active owner" toggle has been retired: views no longer
// filter by a single ambient owner. Instead, read surfaces merge BOTH owners
// (atoms omit `owner`), and each row carries its own `owner` for grouping +
// badges. Owner stays real only at WRITE surfaces (policy writes, the run-panel
// address, create-target choices), where it is chosen explicitly per call.
//
// `ownerLabel` is the one survivor of the old context: the badge/label helper
// used across the app to render an `Owner` value.
// ---------------------------------------------------------------------------

/** Human label for an owner, for badges and toggles. */
export function ownerLabel(owner: Owner): string {
  return owner === "user" ? "Personal" : "Workspace";
}
